import type { SidecarPhase } from "../shared/contracts.js";

export interface RuntimeInteractionState {
  healthy: boolean;
  resyncing: boolean;
  loadingSession: boolean;
  working: boolean;
}

export interface DraftScope {
  workspace: string | undefined;
  sessionId: string | undefined;
}

export interface TimelineScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface WorkspaceSwitchState {
  working: boolean;
  loadingSession: boolean;
  resyncing: boolean;
  resyncRetryAvailable: boolean;
}

export interface SidecarRecoveryState {
  phase: SidecarPhase;
  attempt: number;
  error?: string;
}

export interface SidecarRecoveryGuidance {
  message: string;
  actionLabel: string;
}

export interface PausedResyncWorkspaceEscape<Barrier, Result> {
  syncing: boolean;
  retryPaused: boolean;
  barrier: Barrier | undefined;
  cancelRetryTimer(): void;
  cancelBarrier(): void;
  selectWorkspace(): Promise<Result>;
  resumeBarrier(barrier: Barrier): void;
}

export const RENDERER_CREDENTIAL_BOUNDARY_COPY = "Runtime credentials never enter the renderer.";

export function canOpenSession(state: Pick<RuntimeInteractionState, "healthy" | "resyncing">): boolean {
  return state.healthy && !state.resyncing;
}

export function canEditComposer(
  state: RuntimeInteractionState & { selectedId: string | undefined },
): boolean {
  return Boolean(state.selectedId)
    && state.healthy
    && !state.resyncing
    && !state.loadingSession
    && !state.working;
}

export function canSwitchWorkspace(state: WorkspaceSwitchState): boolean {
  const pausedResyncEscape = state.resyncing && state.resyncRetryAvailable;
  return !state.working
    && (!state.loadingSession || pausedResyncEscape)
    && (!state.resyncing || state.resyncRetryAvailable);
}

export function workspaceSelectionChangesScope(
  previousWorkspace: string | undefined,
  nextWorkspace: string | undefined,
): boolean {
  return previousWorkspace !== nextWorkspace;
}

export function preferredSessionAfterRecovery(
  previousHealthy: boolean,
  nextHealthy: boolean,
  selectedId?: string,
): string | undefined {
  return !previousHealthy && nextHealthy ? selectedId : undefined;
}

export function draftScopeChanged(previous: DraftScope, next: DraftScope): boolean {
  return previous.workspace !== next.workspace || previous.sessionId !== next.sessionId;
}

export function nextBoundedRetryAttempt(current: number, maximum: number): number | undefined {
  if (!Number.isSafeInteger(current) || current < 0
    || !Number.isSafeInteger(maximum) || maximum < 1) {
    throw new RangeError("Retry counts must be non-negative and the maximum must be positive");
  }
  return current < maximum ? current + 1 : undefined;
}

export function shouldFollowTimeline(
  metrics: TimelineScrollMetrics,
  threshold = 72,
): boolean {
  if (!Number.isFinite(threshold) || threshold < 0) throw new RangeError("Timeline threshold must be non-negative");
  return metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop <= threshold;
}

export async function selectWorkspaceEscapingPausedResync<Barrier, Result>(
  input: PausedResyncWorkspaceEscape<Barrier, Result>,
): Promise<Result> {
  const escapedBarrier = input.syncing && input.retryPaused ? input.barrier : undefined;
  if (escapedBarrier !== undefined) {
    input.cancelRetryTimer();
    input.cancelBarrier();
  }
  try {
    return await input.selectWorkspace();
  } finally {
    if (escapedBarrier !== undefined) input.resumeBarrier(escapedBarrier);
  }
}

export function sidecarRecoveryGuidance(
  state: SidecarRecoveryState,
  maximumErrorLength = 600,
): SidecarRecoveryGuidance | undefined {
  if (!Number.isSafeInteger(maximumErrorLength) || maximumErrorLength < 1) {
    throw new RangeError("Sidecar error limit must be a positive safe integer");
  }
  if (state.phase !== "recovering" && state.phase !== "error") return undefined;
  const normalized = state.error?.trim();
  const detail = normalized
    ? normalized.length <= maximumErrorLength
      ? normalized
      : `${normalized.slice(0, maximumErrorLength)}…`
    : undefined;
  if (state.phase === "recovering") {
    const attempt = state.attempt > 0 ? ` (attempt ${state.attempt})` : "";
    return {
      message: `${detail ? `Runtime issue: ${detail} ` : "The local runtime is unavailable. "}Chili is retrying automatically${attempt}.`,
      actionLabel: "Switch workspace…",
    };
  }
  return {
    message: `${detail ? `Runtime issue: ${detail} ` : "The local runtime could not start. "}Automatic retries stopped. Choose this or another workspace to retry the local runtime.`,
    actionLabel: "Choose workspace…",
  };
}
