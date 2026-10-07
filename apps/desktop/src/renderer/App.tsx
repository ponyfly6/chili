import { useReadingPreferences } from "./useReadingPreferences.js";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { DesktopSettings, type SessionSettingsValues } from "./DesktopSettings.js";
import { conversationTitle, matchingDesktopCommands,
  type DesktopCommand, type SettingsPage } from "./conversation-design.js";
import { ProjectSidebar } from "./ProjectSidebar.js";
import { SessionActivityBadge, SessionList } from "./SessionList.js";
import { SidebarActivityMemory } from "./sidebar-activity-memory.js";
import { UserInputCard } from "./UserInputCard.js";
import { createUserInputDraft, type UserInputDraft } from "./user-input-drafts.js";
import { ConversationActivityBar, ConversationQueue } from "./ConversationActivity.js";
import { conversationActivity } from "./conversation-activity.js";
import { ResultsPanel } from "./ResultsPanel.js";
import { DeliveryCard } from "./DeliveryCard.js";
import { ProgressPanel } from "./ProgressPanel.js";
import { ChangesPanel } from "./ChangesPanel.js";
import { latestFileChange } from "./latest-file-change.js";
import { discoverDesktopResults } from "./result-model.js";
import { TimelineViewport } from "./TimelineViewport.js";
import { sessionDescendantAgents } from "./agent-details-model.js";
import { formatWorkDuration, workCurrentDetail, workHeadline, workStages, workToolStatus, workToolSubject, workToolTitle, type WorkStage } from "./work-presentation.js";
import { eventMatchesProject, ProjectViewMemory } from "./project-view-state.js";
import { useDesktopTheme } from "./useDesktopTheme.js";
import { getDesktopBuildInfo } from "../shared/build-info.js";
import { RESULT_PREVIEW_ESCAPE_EVENT } from "../shared/result-preview.js";
import { SESSION_TITLE_MAX_CHARS } from "@chili/protocol";
import { hasRuntimePartStreamGap } from "@chili/sdk";
import type {
  ChiliEvent,
  DelegationPolicy,
  ReasoningLevel,
  RuntimeModelDescriptor,
  RuntimePermissionConfig,
  RuntimePermissionProfileId,
} from "@chili/protocol";
import type {
  ChatMessagePart,
  ChatTranscriptItem,
  RuntimeSessionSummary,
} from "@chili/sdk";
import type {
  DesktopCreateSessionResult,
  DesktopEvent,
  DesktopSessionConfig,
  DesktopState,
  RuntimeSnapshot,
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
  selectWorkspaceEscapingPausedResync,
  sidecarRecoveryGuidance,
  workspaceSelectionChangesScope,
} from "./interaction-model.js";
import { IndependentRefreshScheduler } from "./refresh-scheduler.js";
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
  canResumeTask,
  createNewTaskDraft,
  filterSessions,
  hydrateNewTaskChoices,
  isSessionReadOnly,
  modelFromKey,
  modelKey,
  newTaskSubmission,
  reconcileNewTaskModel,
  sessionModelSettingsMutations,
  validateNewTaskDraft,
  validateSessionModelSettingsDraft,
  type NewTaskDraft,
  type ReasoningSelection,
  type ServiceTierSelection,
  type SessionListStatus,
} from "./task-console-model.js";

type DesktopProjection = CoordinatedProjection<DesktopState, RuntimeSessionSummary, RuntimeSnapshot>;
const MAX_OUTER_RESYNC_RETRIES = 4;
const OUTER_RESYNC_RETRY_DELAY_MS = 500;
type ConversationPanel = "progress" | "files" | "changes";

export function App({ transport: hostTransport }: { transport: ControlTransport }) {
  const buildInfo = getDesktopBuildInfo();
  const { theme, changeTheme, saveFailed: themeSaveFailed, saving: themeSaving } = useDesktopTheme();
  const [settingsPage, setSettingsPage] = useState<SettingsPage>("general");
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [commandIndex, setCommandIndex] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const { preferences, saving: preferencesSaving, saveFailed: preferenceSaveFailed, savePreferences } = useReadingPreferences();
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
  const [inputDrafts, setInputDrafts] = useState<Record<string, UserInputDraft>>({});
  const [sidePanel, setSidePanel] = useState<{ scope: string; view: ConversationPanel; path?: string }>();
  const panelReturnFocus = useRef<HTMLElement | null>(null);
  const [resultTargets, setResultTargets] = useState<Record<string, string>>({});
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const transport = useMemo(() => projection.state.projectId && hostTransport.forProject
    ? hostTransport.forProject(projection.state.projectId) : hostTransport, [hostTransport, projection.state.projectId]);
  const projectViews = useRef(new ProjectViewMemory());
  const sidebarActivity = useRef(new SidebarActivityMemory());
  const requestedProjectSession = useRef<{ projectId: string; sessionId: string } | undefined>(undefined);
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);
  const [loadingSession, setLoadingSession] = useState(false);
  const [resyncing, setResyncing] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 640);
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<RuntimeSessionSummary>();
  const [archiveTarget, setArchiveTarget] = useState<RuntimeSessionSummary>();
  const taskMenuButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const taskMenuRef = useRef<HTMLDivElement | null>(null);
  const dialogReturnFocusRef = useRef<HTMLElement | null>(null);
  const selectedRef = useRef<string | undefined>(undefined);
  const projectionRef = useRef(projection);
  const projectionRefreshes = useMemo(() => new IndependentRefreshScheduler(), []);
  const configRefreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const resyncRetryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const resyncRetryAttempts = useRef(0);
  const manualResyncRetry = useRef<() => void>(() => undefined);
  const selectWorkspaceWithRecoveryEscape = useRef<(select: () => Promise<DesktopState>) => Promise<DesktopState>>(
    (select) => select(),
  );
  const actionInFlightRef = useRef(false);
  const configRequestGate = useRef(createLatestRequestGate());
  const newTaskChoicesGate = useRef(createLatestRequestGate());
  const workspaceRef = useRef<string | undefined>(undefined);
  const sidecarPhaseRef = useRef<DesktopState["sidecar"]["phase"]>("idle");
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const closeSidebar = useCallback(() => {
    if (sidebarRef.current?.contains(document.activeElement)) sidebarToggleRef.current?.focus({ preventScroll: true });
    setSidebarOpen(false);
  }, []);

  const desktop = projection.state;
  const sessions = projection.sessions;
  const selectedId = projection.selectedId;
  const snapshot = projection.snapshot;
  const descendantAgents = useMemo(() => sessionDescendantAgents(snapshot?.agents, selectedId), [snapshot?.agents, selectedId]);
  useEffect(() => {
    projectViews.current.remember(desktop.workspace, selectedId, composer);
  }, [desktop.workspace, selectedId, composer]);
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
        setComposer(projectViews.current.readDraft(published.state.workspace, published.selectedId) ?? "");
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
      if (published.snapshot) sidebarActivity.current.seed(published.state.projectId ?? published.state.workspace, published.snapshot);
      projectionRef.current = published;
      setProjection(published);
      setLoadingSession(false);
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
  const selectedReadOnly = isSessionReadOnly(selectedSession);
  const healthy = desktop.sidecar.phase === "healthy";
  const actionsDisabled = working || resyncing || loadingSession;
  const runtimeActionsDisabled = actionsDisabled || !healthy || selectedReadOnly;
  const composerEditable = canEditComposer({ selectedId: selectedId ?? (healthy ? "new" : undefined), healthy, resyncing, loadingSession, working, readOnly: selectedReadOnly });
  const workspaceSwitchEnabled = canSwitchWorkspace({ working, loadingSession, resyncing, resyncRetryAvailable });
  const sidecarGuidance = sidecarRecoveryGuidance(desktop.sidecar);
  const selectedTitle = selectedSession?.title || selectedSession?.preview || "新会话";
  const projectLabel = workspaceLabel(desktop.workspace);
  const visibleSessions = useMemo(
    () => filterSessions(sessions, sessionQuery, sessionListStatus),
    [sessionListStatus, sessionQuery, sessions],
  );
  const canResumeSession = canResumeTask(presentation?.chat.status, selectedReadOnly, snapshot?.inputQueue?.paused);
  const emptyConversation = !loadingSession && timelineItems.length === 0;
  const conversationScope = JSON.stringify([desktop.projectId, desktop.workspace, selectedId]);
  const resultTarget = resultTargets[conversationScope];
  const activity = conversationActivity({ status: presentation?.chat.status, paused: snapshot?.inputQueue?.paused ?? false,
    pendingQuestions: presentation?.pendingInputs.length ?? 0, readOnly: selectedReadOnly });
  const results = useMemo(() => desktop.workspace && presentation
    ? discoverDesktopResults(presentation.chat.items, desktop.workspace) : [], [desktop.workspace, presentation]);
  const changeTarget = useMemo(() => snapshot?.sessionId === selectedId
    ? latestFileChange(snapshot, presentation?.runtime) : undefined, [snapshot, selectedId, presentation]);
  const hasResults = results.length > 0 && Boolean(transport.readResult);
  const activePanel = sidePanel?.scope === conversationScope ? sidePanel : undefined;
  const narrowPanel = viewportWidth <= 1000;
  const workItems = useMemo(() => timelineItems.filter((item): item is DesktopWorkItem => item.kind === "work"), [timelineItems]);
  const deliveriesByItem = useMemo(() => {
    const bySource = new Map(results.map((result) => [result.messageId, result]));
    return new Map(timelineItems.map((item) => [item.id, (item.kind === "work" ? item.items : [item])
      .flatMap((entry) => { const result = bySource.get(entry.id); return result ? [result] : []; })]));
  }, [results, timelineItems]);
  const openPanel = (view: ConversationPanel, path?: string) => {
    panelReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSidePanel({ scope: conversationScope, view, ...(path ? { path } : {}) });
  };
  const closePanel = () => {
    setSidePanel(undefined);
    const target = panelReturnFocus.current;
    requestAnimationFrame(() => { if (target?.isConnected) target.focus({ preventScroll: true }); });
  };
  useEffect(() => { setSidePanel(undefined); }, [conversationScope]);
  const commands = commandsOpen && !selectedReadOnly ? matchingDesktopCommands(composer.startsWith("/") ? composer : "/") : [];
  useEffect(() => {
    setCommandsOpen(false);
  }, [desktop.projectId, selectedId]);

  const openSettings = (page: SettingsPage = "general") => {
    setSettingsPage(page);
    setSettingsOpen(true);
    setCommandsOpen(false);
  };

  useEffect(() => {
    if (!composer && composerRef.current) composerRef.current.style.height = "";
  }, [composer]);

  useEffect(() => {
    let previousWidth = window.innerWidth;
    const handleResize = (): void => {
      const width = window.innerWidth;
      setViewportWidth(width);
      if (previousWidth > 640 && width <= 640) closeSidebar();
      previousWidth = width;
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [closeSidebar]);

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

  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape" && settingsOpen && !working && !themeSaving && !preferencesSaving) { event.preventDefault(); setSettingsOpen(false); }
    };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [settingsOpen, working, themeSaving, preferencesSaving]);

  const reloadSessionConfig = useCallback(async (sessionId = selectedRef.current) => {
    if (!sessionId || sidecarPhaseRef.current !== "healthy") return;
    const isCurrent = configRequestGate.current.begin();
    const owner = projectionRef.current.state.projectId;
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
    }
  }, [projectTransport]);

  useEffect(() => {
    if (!selectedId || !healthy || resyncing) {
      configRequestGate.current.invalidate();
      setSessionConfig(undefined);
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
      setComposer(projectViews.current.readDraft(workspaceRef.current, sessionId) ?? "");
    }
    setSelectedId(sessionId);
    if (!options.background) {
      setSnapshot(undefined);
      setLoadingSession(true);
    }
    setError(undefined);
    try {
      const next = await coordinator.refreshSessionSnapshot(sessionId);
      if (selectedRef.current === sessionId) {
        sidebarActivity.current.seed(projectionRef.current.state.projectId ?? workspaceRef.current, next);
        setSnapshot(next);
      }
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
        setComposer(projectViews.current.readDraft(workspaceRef.current, undefined) ?? "");
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

  const streamHasGap = presentation ? hasRuntimePartStreamGap(presentation.runtime) : false;
  useEffect(() => {
    if (streamHasGap && healthy && !resyncing) void reloadSelected();
  }, [streamHasGap, healthy, resyncing, selectedId, reloadSelected]);

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
      setLoadingSession(Boolean(selectedRef.current));
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
        coordinator.cancel();
      },
      selectWorkspace,
      resumeBarrier: startResync,
    });
    const unsubscribe = hostTransport.subscribe((envelope) => {
      if (envelope.event.type === "runtime.event") {
        sidebarActivity.current.ingest(envelope.event.projectId ?? projectionRef.current.state.projectId ?? workspaceRef.current, envelope.event.event);
      }
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
        }
        if (workspaceChanged) {
          projectionRefreshes.cancel();
          setComposer(projectViews.current.readDraft(event.state.workspace, undefined) ?? "");
          setNewTaskOpen(false);
          setSettingsOpen(false);
          setRenameTarget(undefined);
          setArchiveTarget(undefined);
          setTaskMenuId(undefined);
          workspaceRef.current = event.state.workspace;
          coordinator.invalidateRequests("sessions", "snapshot", "diff");
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
      if (refreshesSessionConfig(event.event)) {
        if (configRefreshTimer.current) clearTimeout(configRefreshTimer.current);
        configRefreshTimer.current = setTimeout(() => void reloadSessionConfig(), 120);
      }
      if (event.event.type.startsWith("session.")) {
        projectionRefreshes.sessions(() => void refreshSessions());
        if (event.event.type === "session.created" || event.event.type === "session.input_queue_changed"
          || event.event.type === "session.status_changed") {
          projectionRefreshes.snapshot(() => void reloadSelected());
        }
      } else if (event.event.type === "user_input.requested" || event.event.type === "user_input.resolved"
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
      if (configRefreshTimer.current) clearTimeout(configRefreshTimer.current);
      configRefreshTimer.current = undefined;
      clearResyncRetryTimer();
      coordinator.cancel();
    };
  }, [coordinator, projectionRefreshes, refreshSessions, reloadSelected, reloadSessionConfig, setDesktop, setSnapshot, hostTransport]);

  const chooseWorkspace = async (projectId?: string, sessionId?: string) => runAction(async () => {
    requestedProjectSession.current = projectId && sessionId ? { projectId, sessionId } : undefined;
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
      setComposer(projectViews.current.readDraft(state.workspace, undefined) ?? "");
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
    } else {
      setDesktop(state);
    }
    if (state.sidecar.phase === "healthy") await refreshSessions();
  });

  const openAdvancedTask = useCallback(() => {
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

  const openNewTask = useCallback(() => {
    if (!healthy || actionsDisabled) return;
    void runAction(async () => {
      const created = await transport.createSession({ title: "新会话" });
      setSessionListStatus("active");
      setSessionQuery("");
      setTaskMenuId(undefined);
      await refreshSessions(created.sessionId);
      setComposer("");
      if (window.innerWidth <= 640) closeSidebar();
      requestAnimationFrame(() => composerRef.current?.focus());
      if (created.failure) throw new Error(createFailureMessage(created));
    });
  }, [healthy, actionsDisabled, transport, refreshSessions, closeSidebar]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key === ",") { event.preventDefault(); if (!document.querySelector('[role="dialog"]')) { setSettingsPage("general"); setSettingsOpen(true); } return; }
      if (event.key.toLowerCase() !== "n") return;
      event.preventDefault();
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (healthy && !actionsDisabled) openNewTask();
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [actionsDisabled, healthy, openNewTask]);

  const renameSession = async (session: RuntimeSessionSummary, title: string) => {
    const normalized = title.trim();
    if (!normalized || isSessionReadOnly(session)) return;
    await runAction(async () => {
      await transport.renameSession(String(session.id), normalized);
      setRenameTarget(undefined);
      await refreshSessions(String(session.id));
    });
  };

  const archiveSession = async (session: RuntimeSessionSummary) => {
    if (isSessionReadOnly(session)) return;
    await runAction(async () => {
      await transport.archiveSession(String(session.id));
      setArchiveTarget(undefined);
      setSessionListStatus("archived");
      await refreshSessions(String(session.id));
    });
  };

  const resumeSession = async () => {
    if (!selectedId || selectedReadOnly) return;
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

  const saveSessionSettings = async (values: SessionSettingsValues, section: "models" | "permissions") => {
    if (!selectedId || !sessionConfig || selectedReadOnly) return;
    await runAction(async () => {
      if (section === "models") {
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
        if (mutations.reasoningLevel) await transport.setReasoning(selectedId, mutations.reasoningLevel);
        if (mutations.serviceTier) await transport.setServiceTier(selectedId, mutations.serviceTier);
      } else {
        const permission = sessionConfig.permission;
        const currentReviewerKey = permission.reviewerModel ? modelKey(permission.reviewerModel) : "";
        if (values.permissionProfile !== permission.profile
          || values.reviewInstructions !== permission.reviewInstructions
          || values.reviewerModelKey !== currentReviewerKey) {
          const catalog = models.length > 0 ? models : sessionConfig.model.models;
          const reviewer = modelFromKey(catalog, values.reviewerModelKey)
            ?? (values.reviewerModelKey === currentReviewerKey ? permission.reviewerModel : undefined);
          if (values.reviewerModelKey && !reviewer) throw new TypeError("请选择可用的审查模型。");
          await transport.setPermission(values.permissionProfile, {
            reviewInstructions: values.reviewInstructions.trim() ? values.reviewInstructions : permission.reviewInstructions,
            reviewerModel: reviewer ? { provider: reviewer.provider, model: reviewer.model } : null,
          });
        }
        if (values.delegationPolicy !== sessionConfig.delegation.policy) await transport.setDelegation(selectedId, values.delegationPolicy);
      }
      setSettingsOpen(false);
      await reloadSessionConfig(selectedId);
    });
  };

  const reloadMcp = async () => {
    if (!selectedId || selectedReadOnly) return;
    await runAction(async () => {
      await transport.reloadMcp(selectedId);
      await reloadSessionConfig(selectedId);
    });
  };

  const changeMcpConnection = async (server: string, connect: boolean) => {
    if (!selectedId || selectedReadOnly) return;
    const operation = connect ? transport.connectMcp : transport.disconnectMcp;
    if (!operation) return;
    await runAction(async () => {
      let result;
      try { result = await operation(server, selectedId); }
      catch {
        await reloadSessionConfig(selectedId).catch(() => undefined);
        throw new Error(connect ? "连接失败，请检查本机配置后重试。" : "暂时无法断开连接，请重试。");
      }
      await reloadSessionConfig(selectedId);
      if (connect && result.status !== "running") {
        throw new Error(result.status === "auth_required" ? "需要先在本机配置中完成授权，再重试连接。" : "连接未成功，可以检查配置后重试。");
      }
    });
  };

  const chooseCommand = (command: DesktopCommand) => {
    if (selectedReadOnly) return;
    setCommandsOpen(false);
    setCommandIndex(0);
    if (command.group === "prompt") {
      setComposer(command.prompt);
      composerRef.current?.focus();
    } else {
      if (/^\/[^\s]*$/.test(composer)) setComposer("");
      if (command.group === "settings") openSettings(command.page);
      else if (command.group === "advanced") openAdvancedTask();
    }
  };

  const submit = async (mode: "queue" | "steer") => {
    const draft = composer.trim();
    if (!draft || !composerEditable || actionInFlightRef.current) return;
    const localCommand = matchingDesktopCommands(draft).find((command) => `/${command.id}` === draft.toLowerCase());
    if (localCommand) { chooseCommand(localCommand); return; }
    const text = resultTarget ? `请修改文件「${resultTarget}」：\n${draft}` : draft;
    setCommandsOpen(false);
    await runAction(async () => {
      if (!selectedId) {
        const created = await transport.createSession({ title: conversationTitle(text), prompt: text });
        setSessionListStatus("active");
        await refreshSessions(created.sessionId);
        // Never offer a one-click retry when the runtime may already have accepted the prompt.
        setComposer(created.startState === "not_started" ? text : "");
        if (created.failure) throw new Error(createFailureMessage(created));
      } else {
        if (selectedSession?.title === "新会话" && !timelineItems.some((item) => item.kind === "message" && item.role === "user")) {
          await transport.renameSession(selectedId, conversationTitle(text));
        }
        await transport.send(selectedId, text, mode);
        projectViews.current.remember(desktop.workspace, selectedId, "");
        setResultTargets((current) => {
          if (current[conversationScope] !== resultTarget) return current;
          const next = { ...current };
          delete next[conversationScope];
          return next;
        });
        if (projectionRef.current.state.workspace === desktop.workspace && selectedRef.current === selectedId) setComposer("");
      }
      requestAnimationFrame(() => composerRef.current?.focus());
    });
  };

  const stop = async () => {
    if (!selectedId || selectedReadOnly) return;
    await runAction(async () => {
      await transport.stop(selectedId);
    });
  };

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
          <div className="title-context">
            <strong>{projectLabel}</strong>
            <span>/</span>
            <span>{selectedId ? selectedTitle : "新会话"}</span>
          </div>
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

      <main className={`workspace-grid ${sidebarOpen ? "" : "sidebar-collapsed"}`}>
        <aside ref={sidebarRef} className="sidebar panel" aria-hidden={!sidebarOpen} inert={!sidebarOpen}>
          <div className="brand" aria-label="Chili">
            <ChiliMark />
            <span>Chili</span>
            {buildInfo.channel === "preview" ? <small className="desktop-build-label" data-testid="desktop-build-label" title={buildInfo.label}>{buildInfo.label}</small> : null}
          </div>
          <div className="sidebar-actions">
            <button className="new-task-button" aria-label="New task" disabled={!healthy || actionsDisabled} onClick={openNewTask}>
              <span><Icon name="plus" />新会话</span>
              <kbd aria-hidden="true">⌘ N</kbd>
            </button>
            {searchOpen ? <><label className="session-search">
              <span className="sr-only">Search tasks</span>
              <Icon name="search" />
              <input
                type="search"
                aria-label="Search tasks"
                value={sessionQuery}
                onChange={(event) => { setTaskMenuId(undefined); setSessionQuery(event.target.value); }}
                placeholder="搜索此目录的会话"
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
                会话 <span>{sessions.filter((session) => session.status === "active").length}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={sessionListStatus === "archived"}
                className={sessionListStatus === "archived" ? "active" : ""}
                onClick={() => { setTaskMenuId(undefined); setSessionListStatus("archived"); }}
              >
                已归档 <span>{sessions.filter((session) => session.status === "archived").length}</span>
              </button>
            </div></> : null}
          </div>
          <div className="directory-heading"><span>目录</span><div><button className="icon-button" aria-label="搜索会话" aria-expanded={searchOpen} onClick={() => { setSearchOpen(!searchOpen); if (searchOpen) { setSessionQuery(""); setSessionListStatus("active"); } }}><Icon name="search" /></button><button className="icon-button" aria-label="Add project" title="打开目录" disabled={!workspaceSwitchEnabled} onClick={() => void chooseWorkspace()}><Icon name="plus" /></button></div></div>
          <ProjectSidebar projects={desktop.projects ?? []} activeId={desktop.projectId} disabled={!workspaceSwitchEnabled}
            selectedSessionId={selectedId} revealKey={JSON.stringify([searchOpen, sessionQuery, sessionListStatus])}
            onActivate={(id, sessionId) => void chooseWorkspace(id, sessionId)}
            onNewSession={openNewTask}>
          {(initialLimit) => <section className="session-section">
            <div className="section-heading">
              <p className="eyebrow">{sessionListStatus === "active" ? "Recent tasks" : "Archived tasks"}</p>
              <span>{visibleSessions.length}</span>
            </div>
            <SessionList key={JSON.stringify([desktop.projectId, sessionQuery, sessionListStatus, initialLimit])} sessions={visibleSessions} selectedId={selectedId} initialLimit={initialLimit}>
              {(session) => (
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
                      <span className="session-title">{session.title || session.preview || "新会话"}</span>
                      <span className="session-meta">
                        {formatRelativeTime(session.updatedAt)}
                        {(desktop.queuedBySession[session.id] ?? 0) > 0 ? ` · 待处理 ${desktop.queuedBySession[session.id]}` : ""}
                      </span>
                    </span>
                    <SessionActivityBadge {...sidebarActivity.current.read(desktop.projectId ?? desktop.workspace, session.id)}
                      queuedCount={desktop.queuedBySession[session.id] ?? 0}
                      archived={session.status === "archived"} />
                  </button>
                  {canExposeTaskActions(session) ? (
                    <>
                      <button
                        ref={(node) => {
                          const id = String(session.id);
                          if (node) taskMenuButtonRefs.current.set(id, node);
                          else taskMenuButtonRefs.current.delete(id);
                        }}
                        className="session-menu-button"
                        type="button"
                        aria-label={`Task actions for ${session.title || session.preview || "新会话"}`}
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
                          aria-label={`Task actions for ${session.title || session.preview || "新会话"}`}
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
                          }}>重命名</button>
                          <button className="danger-menu-item" role="menuitem" onClick={() => {
                            dialogReturnFocusRef.current = taskMenuButtonRefs.current.get(String(session.id)) ?? null;
                            setArchiveTarget(session);
                            setTaskMenuId(undefined);
                          }}>归档会话</button>
                        </div>
                      ) : null}
                    </>
                  ) : null}
                </div>
              )}
            </SessionList>
              {healthy && sessions.length === 0 ? <p className="empty-copy sidebar-empty">这个目录的会话会出现在这里。</p> : null}
              {healthy && sessions.length > 0 && visibleSessions.length === 0 ? (
                <p className="empty-copy sidebar-empty">没有找到匹配的会话。</p>
              ) : null}
              {!healthy ? <p className="empty-copy sidebar-empty">打开一个目录，开始你的第一个想法。</p> : null}
          </section>}
          </ProjectSidebar>
          <footer className="workspace-picker">
            <button className="sidebar-settings" aria-label="打开设置" onClick={() => openSettings()}><Icon name="settings" /><span>设置</span><kbd>⌘ ,</kbd></button>
            <p title="Local runtime status"><span className={`mini-status phase-${desktop.sidecar.phase}`} /><span>{healthy ? "本机工作空间" : desktop.sidecar.phase === "starting" || desktop.sidecar.phase === "recovering" ? "正在连接…" : "等待打开目录"}</span><span className="sr-only">{desktop.sidecar.phase}</span></p>
          </footer>
        </aside>

        <section className={`conversation panel ${emptyConversation ? "is-empty" : ""}`}>
          <div className="conversation-heading">
            <div className="conversation-title"><h1>{selectedId ? selectedTitle : "新会话"}</h1></div>
            <div className="conversation-heading-actions">
              {activity.kind !== "idle" && !selectedReadOnly ? <span className={`conversation-state state-${activity.kind}`}><span />{activity.label}</span> : null}
              {selectedId ? <button type="button" className="conversation-panel-trigger" aria-pressed={activePanel?.view === "progress"} onClick={() => activePanel?.view === "progress" ? closePanel() : openPanel("progress")}><Icon name="activity" />进展</button> : null}
              {hasResults ? <button type="button" className="conversation-panel-trigger" aria-pressed={activePanel?.view === "files"} onClick={() => activePanel?.view === "files" ? closePanel() : openPanel("files")}>交付文件</button> : null}
              {changeTarget ? <button type="button" className="conversation-panel-trigger" aria-pressed={activePanel?.view === "changes"} onClick={() => activePanel?.view === "changes" ? closePanel() : openPanel("changes")}>改动</button> : null}
              {selectedId && !selectedReadOnly ? <button className="icon-button" aria-label="Task runtime settings" title="会话设置" disabled={runtimeActionsDisabled || !sessionConfig} onClick={() => openSettings("models")}><Icon name="more" /></button> : null}
            </div>
          </div>
          {selectedReadOnly ? (
            <div className="read-only-banner" role="status">
              <Icon name="archive" />
              <span>此会话已归档，可以查看历史记录。</span>
            </div>
          ) : null}

          <div className={`conversation-stage ${activePanel && !narrowPanel ? "has-side-panel" : ""}`}>
          <div className="conversation-dialogue">
          <div className="conversation-body">
          <div className="chat-surface">
          <TimelineViewport scopeKey={JSON.stringify([desktop.projectId, desktop.workspace, selectedId])}>
            {snapshot?.truncated ? <p className="transcript-warning" role="status">{snapshot.warning ?? "This large session was trimmed for desktop safety."}</p> : null}
            {loadingSession ? <p className="empty-copy centered">正在恢复会话…</p> : null}
            {!loadingSession && timelineItems.map((item) => <Fragment key={`${item.kind}:${item.id}`}>
              <TimelineItem item={item} expandWork={preferences.expandWork} />
              {transport.readResult && (deliveriesByItem.get(item.id) ?? []).map((result) => <DeliveryCard key={result.id} result={result} onOpen={(path) => openPanel("files", path)} />)}
            </Fragment>)}
            {emptyConversation ? <div className="welcome-card">
              <div className="welcome-mark"><ChiliMark /></div>
              <h2>你想做点什么？</h2><p>从一个想法开始。</p>
              {!desktop.workspace ? <button className="secondary" disabled={!workspaceSwitchEnabled} onClick={() => void chooseWorkspace()}><Icon name="folder" />打开一个目录</button> : null}
            </div> : null}
          </TimelineViewport>
          </div>
          </div>

          {presentation && presentation.pendingInputs.length > 0 ? (
            <div className="blocking-dock">
              {presentation.pendingInputs.map((input) => {
                const draftKey = JSON.stringify([desktop.workspace, selectedId, input.id]);
                return (
                <UserInputCard
                  key={draftKey}
                  request={input}
                  draft={inputDrafts[draftKey] ?? createUserInputDraft()}
                  onDraftChange={(draft) => setInputDrafts((current) => ({ ...current, [draftKey]: draft }))}
                  disabled={runtimeActionsDisabled}
                  submit={(answers) => runAction(async () => {
                    if (selectedReadOnly) return;
                    await transport.resolveUserInput(input.id, answers);
                    setInputDrafts((current) => { const next = { ...current }; delete next[draftKey]; return next; });
                    await reloadSelected();
                  })}
                />
              ); })}
            </div>
          ) : null}

          <div className="composer-wrap">
            <ConversationQueue queue={snapshot?.inputQueue} pendingCount={desktop.queuedBySession[selectedId ?? ""] ?? 0} />
            {resultTarget ? <div className="composer-result-target"><span>正在修改：{resultTarget}</span><button type="button" aria-label="取消修改对象" onClick={() => setResultTargets((current) => { const next = { ...current }; delete next[conversationScope]; return next; })}><Icon name="close" /></button></div> : null}
            <div className="composer">
              {commandsOpen && commands.length > 0 ? <div id="composer-commands" className="composer-command-menu" role="listbox" aria-label="斜杠命令">
                <p>按需使用</p>{commands.map((command, index) => <button id={`command-${command.id}`} key={command.id} type="button" role="option" aria-selected={index === commandIndex % commands.length}
                  onMouseDown={(event) => event.preventDefault()} onClick={() => chooseCommand(command)}><span>/{command.id}</span><small>{command.label}</small></button>)}
              </div> : null}
              <textarea
                ref={composerRef}
                aria-label="Message composer"
                value={composer}
                onChange={(event) => {
                  setComposer(event.target.value);
                  setCommandsOpen(event.target.value.startsWith("/"));
                  setCommandIndex(0);
                  event.target.style.height = "auto";
                  event.target.style.height = `${Math.min(event.target.scrollHeight, 190)}px`;
                }}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                  if (commands.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                    event.preventDefault(); setCommandIndex((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + commands.length) % commands.length); return;
                  }
                  if (event.key === "Escape") { setCommandsOpen(false); return; }
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    if (commands.length) chooseCommand(commands[commandIndex % commands.length]!);
                    else if (composerEditable) void submit("queue");
                  }
                }}
                placeholder={selectedReadOnly ? "已归档的会话仅供查看" : resultTarget ? "想怎么修改这个文件？" : activity.queueInput ? "补充想法，或告诉 Chili 调整方向…" : emptyConversation ? "说说你想做什么…" : "继续说说你想改哪里…"}
                aria-expanded={commandsOpen && commands.length > 0}
                aria-controls={commandsOpen && commands.length > 0 ? "composer-commands" : undefined}
                aria-activedescendant={commandsOpen && commands.length > 0 ? `command-${commands[commandIndex % commands.length]!.id}` : undefined}
                disabled={!composerEditable}
                rows={2}
              />
              <ConversationActivityBar activity={activity} disabled={!selectedId || runtimeActionsDisabled} canResume={canResumeSession}
                onStop={() => void stop()} onResume={() => void resumeSession()} />
              <div className="composer-actions">
                <div className="composer-context">
                  <button className="slash-trigger" aria-label="更多命令" disabled={!composerEditable} onClick={() => { setCommandsOpen((open) => !open); setCommandIndex(0); composerRef.current?.focus(); }}>/ <span>更多</span></button>
                </div>
                <div className="composer-buttons">
                  {sessionBusy && presentation?.chat.status !== "cancelling" && composer.trim() ? (
                    <button className="steer-button" disabled={!composer.trim() || !selectedId || runtimeActionsDisabled} onClick={() => void submit("steer")}>
                      <Icon name="steer" />调整方向
                    </button>
                  ) : null}
                  {activity.queueInput ? <span className="composer-send-hint">稍后处理</span> : null}
                  <button className="send-button" title={activity.queueInput ? "Queue message" : "Send message"} aria-label={activity.queueInput ? "Queue message" : "Send message"} disabled={!composer.trim() || runtimeActionsDisabled} onClick={() => void submit("queue")}>
                    <Icon name="send" />
                  </button>
                </div>
              </div>
            </div>
            {!emptyConversation ? <p className="composer-key-hint">{activity.hint}</p> : null}
            {emptyConversation ? <div className="conversation-examples">{[
              ["做一个网站", "帮我做一个简洁自然的网站，先了解这个目录，再和我确认具体内容。"],
              ["整理文件", "查看这个目录，给我一个整理文件的建议，先不要移动或删除文件。"],
              ["修改已有作品", "看看这个目录里的作品，告诉我有哪些值得改进的地方。"],
            ].map(([label, prompt]) => <button key={label} disabled={!composerEditable} onClick={() => { setComposer(prompt!); composerRef.current?.focus(); }}>{label}<span aria-hidden="true">↗</span></button>)}</div> : null}
          </div>
          </div>
          {activePanel && selectedId ? <ConversationSidePanel key={conversationScope} title={activePanel.view === "progress" ? "进展" : activePanel.view === "files" ? "交付文件" : "改动"}
            narrow={narrowPanel} onClose={closePanel} returnFocus={panelReturnFocus.current}>
            {activePanel.view === "progress" ? <ProgressPanel projectId={desktop.projectId} sessionId={selectedId} agents={descendantAgents}
              workItems={workItems} pendingQuestions={presentation?.pendingInputs.length ?? 0} {...(presentation ? { runtime: presentation.runtime } : {})}
              inputQueues={Object.fromEntries(Object.entries(presentation?.runtime.sessions ?? {})
                .flatMap(([id, session]) => session.inputQueue ? [[id, session.inputQueue]] : []))} /> : null}
            {activePanel.view === "changes" ? <ChangesPanel transport={transport} sessionId={changeTarget?.sessionId ?? selectedId}
              {...(changeTarget ? { turnId: changeTarget.turnId } : {})} revision={projection.diffRevision} /> : null}
            {activePanel.view === "files" && desktop.workspace ? <ResultsPanel key={conversationScope} transport={transport} sessionId={selectedId} workspace={desktop.workspace}
              results={results} {...(activePanel.path ? { selectedPath: activePanel.path } : {})}
              onSelect={(path) => setSidePanel({ scope: conversationScope, view: "files", path })} renderMarkdown={(text) => <MarkdownText text={text} />}
              {...(!runtimeActionsDisabled ? { onContinue: (path: string) => {
                setResultTargets((current) => ({ ...current, [conversationScope]: path }));
                if (narrowPanel) setSidePanel(undefined);
                // The narrow drawer restores its opener on unmount; then move to the single composer.
                requestAnimationFrame(() => requestAnimationFrame(() => composerRef.current?.focus()));
              } } : {})} /> : null}
          </ConversationSidePanel> : null}
          </div>
        </section>
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

      {settingsOpen ? <ModalFrame labelId="desktop-settings-title" className="desktop-settings-dialog" onClose={() => setSettingsOpen(false)} closeDisabled={working || themeSaving || preferencesSaving}>
        <DesktopSettings page={settingsPage} onPage={setSettingsPage} project={projectLabel} session={selectedId} config={sessionConfig}
          models={models} disabled={runtimeActionsDisabled} busy={working} error={error} theme={theme} onTheme={changeTheme}
          themeSaveFailed={themeSaveFailed} themeSaving={themeSaving || preferencesSaving} preferences={preferences} onPreferences={savePreferences} preferenceSaveFailed={preferenceSaveFailed}
          onSave={(values, section) => void saveSessionSettings(values, section)} onReloadMcp={() => void reloadMcp()}
          {...(transport.connectMcp && transport.disconnectMcp ? { onMcpConnection: (server: string, connect: boolean) => void changeMcpConnection(server, connect) } : {})}
          onPrompt={(text) => { if (selectedReadOnly) return; setSettingsOpen(false); setComposer(text); requestAnimationFrame(() => composerRef.current?.focus()); }}
          onNewSession={() => { setSettingsOpen(false); openNewTask(); }} onClose={() => setSettingsOpen(false)} />
      </ModalFrame> : null}
    </div>
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
          <span><b>1</b> Outcome</span><span><b>2</b> Runtime</span>
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
              <small id="new-task-prompt-help">This becomes the first message in the conversation.</small>
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
                <small className="scope-warning"><Icon name="shield" />Saved as your default and applied to every task in this workspace.</small>
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
        </div>
        <footer className="modal-actions">
          <span>{choicesLoading ? "Loading model and runtime permission choices…" : !choicesReady ? "Runtime choices could not be loaded. Close and try again." : "One task starts with one turn."}</span>
          <div><button className="secondary" type="button" disabled={disabled} onClick={onClose}>Cancel</button><button className="primary create-run-button" type="submit" disabled={disabled || choicesLoading || !choicesReady || !validation.valid}>Create & run</button></div>
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
        <header className="modal-heading"><div><p className="eyebrow">Archive</p><h2 id="archive-task-title">Archive task?</h2><p>{session.title || session.preview || "新会话"}</p></div></header>
        <div className="compact-dialog-body archive-warning"><Icon name="archive" /><p>This removes the task from Active tasks. Archived tasks remain inspectable but are read-only and cannot be restored in this milestone.</p>{archiveDisabled ? <small>Stop the running task before archiving it.</small> : null}</div>
        <footer className="modal-actions"><span /><div><button autoFocus data-modal-initial-focus="true" className="secondary" type="button" disabled={disabled} onClick={onClose}>Cancel</button><button className="danger" type="button" disabled={disabled || archiveDisabled} onClick={onArchive}>归档会话</button></div></footer>
      </div>
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
  "iframe",
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

function ConversationSidePanel({ title, narrow, onClose, returnFocus, children }: {
  title: string;
  narrow: boolean;
  onClose: () => void;
  returnFocus: HTMLElement | null;
  children: ReactNode;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useDialogEscape(onClose, !narrow);
  useEffect(() => {
    window.addEventListener(RESULT_PREVIEW_ESCAPE_EVENT, onClose);
    return () => window.removeEventListener(RESULT_PREVIEW_ESCAPE_EVENT, onClose);
  }, [onClose]);
  useEffect(() => { closeRef.current?.focus({ preventScroll: true }); }, [narrow]);
  const content = <>
    <header className="conversation-side-header">
      <h2 id="conversation-side-title">{title}</h2>
      <button ref={closeRef} type="button" className="icon-button" aria-label="关闭侧栏" onClick={onClose}><Icon name="close" /></button>
    </header>
    <div className="conversation-side-content">{children}</div>
  </>;
  if (narrow) return <ModalFrame labelId="conversation-side-title" className="conversation-side-dialog" onClose={onClose} closeDisabled={false} returnFocus={returnFocus}>{content}</ModalFrame>;
  return <aside className="conversation-side-panel" aria-label="会话侧栏" onKeyDown={(event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
  }}>{content}</aside>;
}

function TimelineItem({ item, expandWork }: { item: DesktopTimelineItem; expandWork: boolean }) {
  if (item.kind === "work") return <WorkSummary item={item} expandWork={expandWork} />;
  return (
    <article className={`timeline-item message message-${item.role}`}>
      <div className="message-content">
        {item.role === "assistant" ? <div className="message-author"><ChiliMark /><span>Chili</span></div> : null}
        <div className="message-body">{item.parts.map((part) => <MessagePart key={part.id} part={part} />)}</div>
      </div>
    </article>
  );
}

function WorkSummary({ item, expandWork }: { item: DesktopWorkItem; expandWork: boolean }) {
  const [open, setOpen] = useState(expandWork);
  const [hasOpened, setHasOpened] = useState(expandWork);
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    setOpen(expandWork);
  }, [expandWork]);
  useEffect(() => {
    if (!item.active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [item.active]);

  const elapsed = Math.max(0, (item.active ? Math.max(now, item.updatedAt) : item.updatedAt) - item.startedAt);
  const stages = useMemo(() => workStages(item), [item]);
  const detail = item.active ? workCurrentDetail(item) : undefined;

  return (
    <details
      className={`timeline-item work-summary ${item.active ? "active" : ""} ${item.status === "failed" ? "has-failure" : ""}`}
      open={open}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
        if (event.currentTarget.open) setHasOpened(true);
      }}
    >
      <summary>
        <span className="work-indicator" aria-hidden="true" />
        <span className="work-headline" aria-live="polite">{workHeadline(item)}</span>
        <span className="work-metrics">{item.toolCount > 0 ? `${item.toolCount} 次操作 · ` : ""}{formatWorkDuration(elapsed)}</span>
        {detail ? <span className="work-current-detail" title={detail}>{detail}</span> : null}
        {item.statusReason && item.status === "failed" ? <span className="work-terminal-detail" title={item.statusReason}>{item.statusReason}</span> : null}
      </summary>
      <div className="work-details">
        {open || hasOpened ? stages.map((stage) => <WorkStageDetail key={stage.id} stage={stage} />) : null}
        {item.failureCount > 0 ? <p className="work-history-note">记录中有 {item.failureCount} 次调用未成功，详情保留在对应操作中。</p> : null}
      </div>
    </details>
  );
}

function WorkStageDetail({ stage }: { stage: WorkStage }) {
  const [open, setOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  return (
    <details className={`work-stage ${stage.active ? "active" : ""}`} open={open} onToggle={(event) => {
      setOpen(event.currentTarget.open);
      if (event.currentTarget.open) setHasOpened(true);
    }}>
      <summary><span className="work-stage-indicator" aria-hidden="true">{stage.active ? "·" : "›"}</span><span>{stage.label}</span><span className="work-stage-meta">{stage.active ? "进行中" : stage.failureCount > 0 ? "含未成功操作" : "已结束"}{stage.toolCount > 0 ? ` · ${stage.toolCount} 次` : ""}</span></summary>
      <div className="work-stage-details">{open || hasOpened ? stage.items.map((detail) => <WorkDetail key={`${detail.kind}:${detail.id}`} item={detail} />) : null}</div>
    </details>
  );
}

function WorkDetail({ item }: { item: ChatTranscriptItem }) {
  if (item.kind === "message") {
    const note = item.parts.filter((part) => part.type !== "reasoning");
    const reasoning = item.parts.filter((part) => part.type === "reasoning");
    const preview = note.find((part) => part.type === "text");
    return (
      <div className="work-note">
        {reasoning.map((part) => <MessagePart key={part.id} part={part} compact />)}
        {note.length > 0 ? <details className="work-commentary"><summary><span>{preview?.type === "text" ? preview.text.split("\n").find((line) => line.trim()) || "过程说明" : "过程说明"}</span></summary><div>{note.map((part) => <MessagePart key={part.id} part={part} compact />)}</div></details> : null}
      </div>
    );
  }

  if (item.kind === "tool") {
    const liveOutput = visibleToolLiveOutput(item.output, item.liveOutput);
    const hasOutput = Boolean(liveOutput || item.output || item.error);
    const subject = workToolSubject(item);
    const command = item.inputSummary.command ?? item.inputSummary.detail;
    return (
      <div className={`work-tool-row tool-${item.displayStatus}`}>
        <span className="work-tool-dot" aria-hidden="true" />
        <div className="work-tool-copy">
          <strong>{workToolTitle(item)}</strong>
          {subject ? <span title={subject}>{subject}</span> : null}
        </div>
        <span className="work-tool-status">{workToolStatus(item.displayStatus)}</span>
        {hasOutput || command || item.input ? (
          <details className="tool-details">
            <summary>{item.error ? "查看调用与错误" : liveOutput ? "查看调用与实时输出" : "查看调用与结果"}</summary>
            {command ? <pre className="tool-command">{command}</pre> : null}
            {item.input !== undefined ? <details className="tool-input"><summary>完整参数</summary><pre>{JSON.stringify(item.input, null, 2)}</pre></details> : null}
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
        <strong>{item.status === "pending" ? "请求授权" : "授权记录"}</strong>
        <span>{item.patterns.join(", ") || item.permission}</span>
      </div>
      {item.status === "pending" ? <span className="work-tool-status">等待处理</span> : null}
      {item.status === "resolved" && item.decision === "deny" ? <span className="work-tool-status">已拒绝</span> : null}
    </div>
  );
}

export function MessagePart({ part, compact = false }: { part: ChatMessagePart; compact?: boolean }) {
  if (part.type === "text" || part.type === "reasoning") {
    const incomplete = part.completion === "cancelled" ? "已停止，内容未完成"
      : part.completion === "failed" ? "生成失败，内容未完成" : undefined;
    const content = <MarkdownText text={part.text} compact={part.type === "reasoning" || compact} />;
    return part.type === "reasoning"
      ? <details className="work-reasoning"><summary>思考过程{incomplete ? ` · ${incomplete}` : ""}</summary>{content}</details>
      : <>{content}{incomplete ? <p className="work-history-note">{incomplete}</p> : null}</>;
  }
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

type IconName = "activity" | "archive" | "chevron" | "close" | "folder" | "message" | "more"
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

function refreshesSessionConfig(event: ChiliEvent): boolean {
  return event.type === "session.model_changed"
    || event.type === "session.reasoning_changed"
    || event.type === "session.service_tier_changed"
    || event.type === "session.delegation_changed"
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
    || frame.event.type === "user_input.requested"
    || frame.event.type === "user_input.resolved"
    || frame.event.type === "user_input.cancelled";
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
