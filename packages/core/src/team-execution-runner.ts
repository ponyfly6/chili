import type {
  AgentPath,
  ChiliEvent,
  EventEnvelope,
  SessionId,
  TaskId,
  TeamId,
  TeamRunLifecyclePhase,
  TeamRunStopReason,
  TeamRunSummaryCounts,
  TeamTaskStatus,
  ThreadId,
  TimestampMs,
} from "@chili/protocol";
import { timestampNow } from "@chili/protocol";
import type { TeamMemberRow, TeamRow, TeamTaskRow } from "@chili/store";
import type { LocalSubagentMode } from "./subagent.js";
import type {
  TeamTaskDispatchResult,
  TeamTaskDispatchService,
  TeamTaskReconcileResult,
  TeamTaskSyncResult,
} from "./team-dispatcher.js";
import type {
  TeamMergeInput,
  TeamMergeSkippedReason,
  TeamMergeSweepResult,
  TeamMergeTaskResult,
  TeamMergeTaskSkipped,
} from "./team-merge.js";
import type {
  TeamTaskVerifierSkipReason,
  TeamTaskVerifierSweepInput,
  TeamTaskVerifierSweepResult,
  TeamTaskVerifierVerifiedResult,
} from "./team-verifier.js";
import { isAcceptedTeamTask, isCompletedButUnverifiedTeamTask, isReopenedAfterFailedVerification } from "./team-verifier.js";
import { taskMergeMetadata } from "./team-worktree.js";
import type { TeamControlService } from "./team.js";

export interface TeamExecutionRunnerOptions {
  teams: TeamControlService;
  dispatcher: TeamTaskDispatchService;
  verifier?: TeamTaskVerifier;
  merger?: TeamTaskMerger;
  events?: TeamRunEventStore;
  cwd: string;
  now?: () => TimestampMs;
  createId?: (prefix: string) => string;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  createSession?: (input: TeamExecutionSessionRequest) => Promise<TeamExecutionSession>;
}

export interface TeamRunEventStore {
  append(event: ChiliEvent): Promise<void>;
}

export interface TeamTaskVerifier {
  verifyCompletedTasks(input: TeamTaskVerifierSweepInput): Promise<TeamTaskVerifierSweepResult>;
}

export interface TeamTaskMerger {
  mergeTeamTasks(input: TeamMergeInput): Promise<TeamMergeSweepResult>;
}

export interface TeamExecutionSessionRequest {
  teamId: TeamId;
  cwd: string;
  signal?: AbortSignal;
}

export interface TeamExecutionSession {
  sessionId: SessionId;
  threadId?: ThreadId;
}

export interface TeamExecutionRunInput {
  teamId: TeamId;
  sessionId?: SessionId;
  threadId?: ThreadId;
  cwd?: string;
  mode?: LocalSubagentMode;
  once?: boolean;
  maxCycles?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  maxConcurrentDispatches?: number;
  signal?: AbortSignal;
}

export interface TeamExecutionRunSummary {
  teamId: TeamId;
  cycles: number;
  stopReason: TeamExecutionStopReason;
  startedAt: number;
  endedAt: number;
  maxConcurrentDispatches: number;
  dispatched: TeamExecutionDispatchedTask[];
  completed: TeamExecutionFinalTask[];
  accepted: TeamExecutionFinalTask[];
  reopened: TeamExecutionVerificationTask[];
  merged: TeamExecutionMergeTask[];
  mergeFailed: TeamExecutionMergeTask[];
  mergeConflicted: TeamExecutionMergeTask[];
  mergeSkipped: TeamExecutionMergeSkippedTask[];
  failed: TeamExecutionFinalTask[];
  blocked: TeamExecutionSkippedTask[];
  skipped: TeamExecutionSkippedTask[];
  stillRunning: TeamExecutionRunningTask[];
  errors: TeamExecutionError[];
}

export type TeamExecutionStopReason = TeamRunStopReason;

export interface TeamExecutionDispatchedTask {
  teamId: TeamId;
  taskId: TaskId;
  ownerPath?: AgentPath;
  agentTaskId?: TaskId;
  status: TeamTaskDispatchResult["status"];
}

export interface TeamExecutionFinalTask {
  teamId: TeamId;
  taskId: TaskId;
  ownerPath?: AgentPath;
  status: Extract<TeamTaskStatus, "completed" | "failed" | "cancelled">;
  summary?: string;
  error?: string;
  agentTaskId?: TaskId;
}

export interface TeamExecutionVerificationTask {
  teamId: TeamId;
  taskId: TaskId;
  ownerPath?: AgentPath;
  status: "passed" | "failed";
  feedback?: string;
  verifierTaskId?: TaskId;
}

export interface TeamExecutionMergeTask {
  teamId: TeamId;
  taskId: TaskId;
  ownerPath?: AgentPath;
  status: "applied" | "failed" | "conflicted";
  diffSummary?: unknown;
  error?: string;
  conflicts?: string[];
}

export interface TeamExecutionMergeSkippedTask {
  teamId: TeamId;
  taskId: TaskId;
  ownerPath?: AgentPath;
  reason: TeamMergeSkippedReason;
  error?: string;
}

export interface TeamExecutionSkippedTask {
  teamId: TeamId;
  taskId: TaskId;
  ownerPath?: AgentPath;
  reason: TeamExecutionSkipReason;
  blockedBy?: TaskId[];
}

export type TeamExecutionSkipReason =
  | "dependency_incomplete"
  | "missing_owner"
  | "missing_session"
  | "missing_member"
  | "member_unavailable"
  | "scope_mismatch"
  | "write_conflict"
  | "blocked"
  | "already_claimed"
  | "already_resolved"
  | "not_dispatched"
  | "agent_task_not_found"
  | "team_already_final";

export interface TeamExecutionRunningTask {
  teamId: TeamId;
  taskId: TaskId;
  ownerPath?: AgentPath;
  title: string;
  agentTaskId?: TaskId;
}

export interface TeamExecutionError {
  teamId: TeamId;
  taskId?: TaskId;
  error: string;
}

interface TeamExecutionState {
  team: TeamRow;
  tasks: TeamTaskRow[];
  members: TeamMemberRow[];
}

interface SessionState {
  sessionId?: SessionId;
  threadId?: ThreadId;
}

interface TeamDispatchWork {
  task: TeamTaskRow;
  input: Parameters<TeamTaskDispatchService["dispatchTask"]>[0];
}

interface DispatchReservations {
  owners: Set<AgentPath>;
  writeScopes: TeamDispatchWriteReservation[];
}

interface TeamDispatchWriteReservation {
  taskId: TaskId;
  ownerPath?: AgentPath;
  writeScope: string[];
}

const DEFAULT_MAX_CYCLES = 50;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_MAX_CONCURRENT_DISPATCHES = 4;
const MAX_CONCURRENT_DISPATCHES = 64;

export class TeamExecutionRunner {
  constructor(private readonly options: TeamExecutionRunnerOptions) {}

  async run(input: TeamExecutionRunInput): Promise<TeamExecutionRunSummary> {
    const startedAt = Number(this.now());
    const runId = this.id("teamrun");
    const maxCycles = input.once ? 1 : input.maxCycles ?? DEFAULT_MAX_CYCLES;
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const maxConcurrentDispatches = normalizeMaxConcurrentDispatches(input.maxConcurrentDispatches);
    const startedMonotonic = Date.now();
    const sessionState: SessionState = {};
    if (input.sessionId) sessionState.sessionId = input.sessionId;
    if (input.threadId) sessionState.threadId = input.threadId;
    const summary: TeamExecutionRunSummary = {
      teamId: input.teamId,
      cycles: 0,
      stopReason: "drained",
      startedAt,
      endedAt: startedAt,
      maxConcurrentDispatches,
      dispatched: [],
      completed: [],
      accepted: [],
      reopened: [],
      merged: [],
      mergeFailed: [],
      mergeConflicted: [],
      mergeSkipped: [],
      failed: [],
      blocked: [],
      skipped: [],
      stillRunning: [],
      errors: [],
    };

    const initialState = await this.loadState(input.teamId);
    await this.publishRunStarted(input, sessionState, initialState.team, runId, {
      maxCycles,
      timeoutMs,
      pollIntervalMs,
      maxConcurrentDispatches,
    });
    if (initialState.team.status !== "active") {
      summary.stopReason = "team_inactive";
      summary.endedAt = Number(this.now());
      await this.publishRunCompleted(input, sessionState, initialState.team, runId, summary);
      return summary;
    }

    while (true) {
      const preCycleStop = controlStopReason(input, startedMonotonic, timeoutMs);
      if (preCycleStop) {
        summary.stopReason = preCycleStop;
        break;
      }
      if (summary.cycles >= maxCycles) {
        summary.stopReason = "max_cycles";
        break;
      }

      summary.cycles++;
      const reconciled = await this.reconcile(input, summary, sessionState);
      this.collectReconcile(reconciled, summary);
      const postReconcileStop = controlStopReason(input, startedMonotonic, timeoutMs);
      await this.publishRunProgress(input, sessionState, initialState.team, runId, summary, "reconcile", postReconcileStop);
      if (postReconcileStop) {
        summary.stopReason = postReconcileStop;
        break;
      }

      let state = await this.loadState(input.teamId);
      if (state.team.status !== "active") {
        summary.stopReason = "team_inactive";
        await this.publishRunProgress(input, sessionState, state.team, runId, summary, "load", "team_inactive");
        break;
      }
      const postLoadStop = controlStopReason(input, startedMonotonic, timeoutMs);
      await this.publishRunProgress(input, sessionState, state.team, runId, summary, "load", postLoadStop);
      if (postLoadStop) {
        summary.stopReason = postLoadStop;
        break;
      }

      const verified = await this.verifyCompletedTasks(input, summary, sessionState);
      this.collectVerification(verified, summary);
      const postVerifyStop = controlStopReason(input, startedMonotonic, timeoutMs);
      await this.publishRunProgress(input, sessionState, state.team, runId, summary, "verify", postVerifyStop);
      if (postVerifyStop) {
        summary.stopReason = postVerifyStop;
        break;
      }
      const merged = await this.mergeVerifiedTasks(input, summary, sessionState);
      this.collectMerge(merged, summary);
      const postMergeStop = controlStopReason(input, startedMonotonic, timeoutMs);
      await this.publishRunProgress(input, sessionState, state.team, runId, summary, "merge", postMergeStop);
      if (postMergeStop) {
        summary.stopReason = postMergeStop;
        break;
      }
      if (
        (verified && (verified.verified.length > 0 || verified.skipped.length > 0)) ||
        (merged && (merged.applied.length > 0 || merged.failed.length > 0 || merged.conflicted.length > 0 || merged.skipped.length > 0))
      ) {
        state = await this.loadState(input.teamId);
      }

      const dispatches: TeamDispatchWork[] = [];
      const reservations = dispatchReservationsForRunningTasks(state.tasks);
      for (const task of state.tasks) {
        if (controlStopReason(input, startedMonotonic, timeoutMs)) break;
        if (task.status !== "pending") continue;

        const blockedBy = incompleteDependencies(task, state.tasks, Boolean(this.options.verifier));
        if (blockedBy.length > 0) {
          const skipped: TeamExecutionSkippedTask = {
            teamId: input.teamId,
            taskId: task.id,
            reason: "dependency_incomplete",
            blockedBy,
          };
          if (task.ownerPath) skipped.ownerPath = task.ownerPath;
          pushUniqueSkipped(summary.blocked, skipped);
          continue;
        }

        const ownerSelection = task.ownerPath ? { ownerPath: task.ownerPath } : selectDispatchOwner(task, state.members, reservations);
        const ownerPath = ownerSelection.ownerPath;
        if (!ownerPath) {
          this.collectDispatchSkip(input.teamId, task, ownerSelection.reason ?? "missing_owner", summary);
          continue;
        }
        const dispatchTask = task.ownerPath ? task : { ...task, ownerPath };

        if (!this.currentSessionId(state.team, dispatchTask, sessionState, input)) {
          let ensured: SessionState;
          try {
            ensured = await this.ensureSession(input, sessionState);
          } catch (error) {
            const stopReason = controlStopReason(input, startedMonotonic, timeoutMs);
            if (stopReason) break;
            summary.errors.push({
              teamId: input.teamId,
              taskId: task.id,
              error: toError(error).message,
            });
            continue;
          }
          if (!ensured.sessionId) {
            pushUniqueSkipped(summary.skipped, {
              teamId: input.teamId,
              taskId: task.id,
              ownerPath,
              reason: "missing_session",
            });
            continue;
          }
          if (controlStopReason(input, startedMonotonic, timeoutMs)) break;
        }

        const reserved = reserveDispatchResources(dispatchTask, reservations);
        if (!reserved.allowed) {
          this.collectDispatchSkip(input.teamId, dispatchTask, reserved.reason, summary);
          continue;
        }

        const dispatchInput: Parameters<TeamTaskDispatchService["dispatchTask"]>[0] = {
          teamId: input.teamId,
          taskId: task.id,
          mode: input.mode ?? "background",
          cwd: input.cwd ?? this.options.cwd,
        };
        dispatchInput.ownerPath = ownerPath;
        const sessionId = sessionState.sessionId ?? dispatchTask.sessionId ?? state.team.sessionId;
        if (sessionId) dispatchInput.sessionId = sessionId;
        const threadId = sessionState.threadId ?? input.threadId;
        if (threadId) dispatchInput.threadId = threadId;
        if (input.signal) dispatchInput.signal = input.signal;
        dispatches.push({ task: dispatchTask, input: dispatchInput });
      }

      for (const batch of chunk(dispatches, maxConcurrentDispatches)) {
        if (controlStopReason(input, startedMonotonic, timeoutMs)) break;
        const results = await Promise.all(batch.map(async (work) => {
          try {
            return { work, result: await this.options.dispatcher.dispatchTask(work.input) };
          } catch (error) {
            return { work, error };
          }
        }));

        for (const item of results) {
          if ("result" in item) {
            this.collectDispatch(item.result, summary);
            continue;
          }
          if (controlStopReason(input, startedMonotonic, timeoutMs)) break;
          summary.errors.push({
            teamId: input.teamId,
            taskId: item.work.task.id,
            error: toError(item.error).message,
          });
        }
      }

      const postScanStop = controlStopReason(input, startedMonotonic, timeoutMs);
      await this.publishRunProgress(input, sessionState, state.team, runId, summary, "dispatch", postScanStop);
      if (postScanStop) {
        summary.stopReason = postScanStop;
        break;
      }

      if (input.once) {
        summary.stopReason = "once";
        break;
      }

      const postCycle = await this.loadState(input.teamId);
      const postCycleStop = controlStopReason(input, startedMonotonic, timeoutMs);
      if (postCycleStop) {
        summary.stopReason = postCycleStop;
        await this.publishRunProgress(input, sessionState, postCycle.team, runId, summary, "wait", postCycleStop);
        break;
      }
      const stillRunning = runningTasks(postCycle.tasks);
      const runnable = runnablePendingTasks(
        postCycle,
        input,
        sessionState,
        Boolean(this.options.createSession),
        Boolean(this.options.verifier),
      );
      const unverified = this.unverifiedTasks(postCycle.tasks);
      const reopened = this.reopenedTasks(postCycle.tasks);
      const pendingMerge = this.pendingMergeTasks(postCycle.tasks);
      if (
        stillRunning.length === 0 &&
        runnable.length === 0 &&
        unverified.length === 0 &&
        reopened.length === 0 &&
        pendingMerge.length === 0
      ) {
        summary.stopReason = "drained";
        await this.publishRunProgress(input, sessionState, postCycle.team, runId, summary, "drain", "drained");
        break;
      }

      if (stillRunning.length > 0 && !input.signal?.aborted) {
        await this.publishRunProgress(input, sessionState, postCycle.team, runId, summary, "wait");
        await this.sleep(Math.min(pollIntervalMs, remainingDelay(timeoutMs, startedMonotonic)), input.signal);
      }
    }

    const finalState = await this.loadState(input.teamId);
    summary.stillRunning = runningTasks(finalState.tasks).map((task) => runningTaskSummary(task));
    summary.accepted = this.acceptedTasks(finalState.tasks).map((task) => finalTaskSummary(task, undefined)).filter(isDefined);
    summary.endedAt = Number(this.now());
    await this.publishRunCompleted(input, sessionState, finalState.team, runId, summary);
    return summary;
  }

  private async reconcile(
    input: TeamExecutionRunInput,
    summary: TeamExecutionRunSummary,
    sessionState: SessionState,
  ): Promise<TeamTaskReconcileResult | undefined> {
    try {
      const reconcileInput: Parameters<TeamTaskDispatchService["reconcileTasks"]>[0] = {
        teamId: input.teamId,
      };
      const sessionId = sessionState.sessionId ?? input.sessionId;
      const threadId = sessionState.threadId ?? input.threadId;
      if (sessionId) reconcileInput.sessionId = sessionId;
      if (threadId) reconcileInput.threadId = threadId;
      return await this.options.dispatcher.reconcileTasks(reconcileInput);
    } catch (error) {
      summary.errors.push({
        teamId: input.teamId,
        error: toError(error).message,
      });
      return undefined;
    }
  }

  private collectReconcile(result: TeamTaskReconcileResult | undefined, summary: TeamExecutionRunSummary): void {
    if (!result) return;
    for (const synced of result.synced) this.collectSynced(synced, summary);
    for (const skipped of result.skipped) {
      if (skipped.reason === "agent_running") continue;
      const reason = syncSkipReason(skipped.reason);
      if (!reason) continue;
      const item: TeamExecutionSkippedTask = {
        teamId: skipped.teamTask.teamId,
        taskId: skipped.teamTask.id,
        reason,
      };
      if (skipped.teamTask.ownerPath) item.ownerPath = skipped.teamTask.ownerPath;
      pushUniqueSkipped(summary.skipped, item);
    }
    for (const error of result.errors) {
      summary.errors.push({
        teamId: error.teamId,
        taskId: error.taskId,
        error: error.error,
      });
    }
  }

  private collectSynced(result: TeamTaskSyncResult, summary: TeamExecutionRunSummary): void {
    if (!result.applied) return;
    removeSkipped(summary, result.teamTask.id);
    const final = finalTaskSummary(result.teamTask, result.agentTask?.id);
    if (!final) return;
    if (final.status === "completed") pushUniqueFinal(summary.completed, final);
    else pushUniqueFinal(summary.failed, final);
  }

  private async verifyCompletedTasks(
    input: TeamExecutionRunInput,
    summary: TeamExecutionRunSummary,
    sessionState: SessionState,
  ): Promise<TeamTaskVerifierSweepResult | undefined> {
    if (!this.options.verifier) return undefined;
    try {
      const verifierInput: TeamTaskVerifierSweepInput = {
        teamId: input.teamId,
        cwd: input.cwd ?? this.options.cwd,
      };
      const sessionId = sessionState.sessionId ?? input.sessionId;
      const threadId = sessionState.threadId ?? input.threadId;
      if (sessionId) verifierInput.sessionId = sessionId;
      if (threadId) verifierInput.threadId = threadId;
      if (input.signal) verifierInput.signal = input.signal;
      return await this.options.verifier.verifyCompletedTasks(verifierInput);
    } catch (error) {
      if (isAbortError(error)) return undefined;
      summary.errors.push({
        teamId: input.teamId,
        error: toError(error).message,
      });
      return undefined;
    }
  }

  private collectVerification(result: TeamTaskVerifierSweepResult | undefined, summary: TeamExecutionRunSummary): void {
    if (!result) return;
    for (const verified of result.verified) {
      removeSkipped(summary, verified.teamTask.id);
      if (verified.status === "passed") {
        const final = finalTaskSummary(verified.teamTask, undefined);
        if (final) pushUniqueFinal(summary.accepted, final);
        continue;
      }
      pushUniqueVerification(summary.reopened, verificationSummary(verified));
    }
    for (const skipped of result.skipped) {
      const item: TeamExecutionSkippedTask = {
        teamId: skipped.teamTask.teamId,
        taskId: skipped.teamTask.id,
        reason: verifierSkipReason(skipped.reason),
      };
      if (skipped.teamTask.ownerPath) item.ownerPath = skipped.teamTask.ownerPath;
      pushUniqueSkipped(summary.skipped, item);
    }
    for (const error of result.errors) {
      summary.errors.push({
        teamId: error.teamId,
        taskId: error.taskId,
        error: error.error,
      });
    }
  }

  private async mergeVerifiedTasks(
    input: TeamExecutionRunInput,
    summary: TeamExecutionRunSummary,
    sessionState: SessionState,
  ): Promise<TeamMergeSweepResult | undefined> {
    if (!this.options.merger) return undefined;
    try {
      const mergeInput: TeamMergeInput = {
        teamId: input.teamId,
        cwd: input.cwd ?? this.options.cwd,
      };
      const sessionId = sessionState.sessionId ?? input.sessionId;
      const threadId = sessionState.threadId ?? input.threadId;
      if (sessionId) mergeInput.sessionId = sessionId;
      if (threadId) mergeInput.threadId = threadId;
      if (input.signal) mergeInput.signal = input.signal;
      return await this.options.merger.mergeTeamTasks(mergeInput);
    } catch (error) {
      if (isAbortError(error)) return undefined;
      summary.errors.push({
        teamId: input.teamId,
        error: toError(error).message,
      });
      return undefined;
    }
  }

  private collectMerge(result: TeamMergeSweepResult | undefined, summary: TeamExecutionRunSummary): void {
    if (!result) return;
    for (const item of result.applied) pushUniqueMerge(summary.merged, mergeSummary(item));
    for (const item of result.failed) pushUniqueMerge(summary.mergeFailed, mergeSummary(item));
    for (const item of result.conflicted) pushUniqueMerge(summary.mergeConflicted, mergeSummary(item));
    for (const item of result.skipped) pushUniqueMergeSkipped(summary.mergeSkipped, mergeSkippedSummary(item));
    for (const error of result.errors) {
      summary.errors.push({
        teamId: error.teamId,
        taskId: error.taskId,
        error: error.error,
      });
    }
  }

  private collectDispatch(result: TeamTaskDispatchResult, summary: TeamExecutionRunSummary): void {
    if (result.status === "skipped") {
      const reason = dispatchSkipReason(result.reason);
      const item: TeamExecutionSkippedTask = {
        teamId: result.teamTask.teamId,
        taskId: result.teamTask.id,
        reason,
      };
      if (result.teamTask.ownerPath) item.ownerPath = result.teamTask.ownerPath;
      if (reason === "blocked" || reason === "scope_mismatch" || reason === "write_conflict" || reason === "missing_member") {
        pushUniqueSkipped(summary.blocked, item);
      } else {
        pushUniqueSkipped(summary.skipped, item);
      }
      return;
    }

    removeSkipped(summary, result.teamTask.id);
    const dispatched: TeamExecutionDispatchedTask = {
      teamId: result.teamTask.teamId,
      taskId: result.teamTask.id,
      status: result.status,
    };
    if (result.teamTask.ownerPath) dispatched.ownerPath = result.teamTask.ownerPath;
    if (result.agentTask?.taskId) dispatched.agentTaskId = result.agentTask.taskId;
    pushUniqueDispatch(summary.dispatched, dispatched);

    const final = finalTaskSummary(result.teamTask, result.agentTask?.taskId);
    if (!final) return;
    if (final.status === "completed") pushUniqueFinal(summary.completed, final);
    else pushUniqueFinal(summary.failed, final);
  }

  private collectDispatchSkip(
    teamId: TeamId,
    task: TeamTaskRow,
    reason: TeamExecutionSkipReason,
    summary: TeamExecutionRunSummary,
  ): void {
    const item: TeamExecutionSkippedTask = {
      teamId,
      taskId: task.id,
      reason,
    };
    if (task.ownerPath) item.ownerPath = task.ownerPath;
    if (reason === "blocked" || reason === "scope_mismatch" || reason === "write_conflict" || reason === "missing_member") {
      pushUniqueSkipped(summary.blocked, item);
    } else {
      pushUniqueSkipped(summary.skipped, item);
    }
  }

  private currentSessionId(
    team: TeamRow,
    task: TeamTaskRow,
    state: SessionState,
    input: TeamExecutionRunInput,
  ): SessionId | undefined {
    return state.sessionId ?? input.sessionId ?? task.sessionId ?? team.sessionId;
  }

  private async ensureSession(input: TeamExecutionRunInput, state: SessionState): Promise<SessionState> {
    if (state.sessionId || !this.options.createSession) return state;
    const request: TeamExecutionSessionRequest = {
      teamId: input.teamId,
      cwd: input.cwd ?? this.options.cwd,
    };
    if (input.signal) request.signal = input.signal;
    const created = await this.options.createSession(request);
    state.sessionId = created.sessionId;
    if (created.threadId) state.threadId = created.threadId;
    return state;
  }

  private async loadState(teamId: TeamId): Promise<TeamExecutionState> {
    const team = (await this.options.teams.listTeams()).find((item) => item.id === teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);
    const [tasks, members] = await Promise.all([this.options.teams.tasks(teamId), this.options.teams.members(teamId)]);
    return { team, tasks, members };
  }

  private acceptedTasks(tasks: readonly TeamTaskRow[]): TeamTaskRow[] {
    if (!this.options.verifier) return [];
    return tasks.filter(isAcceptedTeamTask);
  }

  private unverifiedTasks(tasks: readonly TeamTaskRow[]): TeamTaskRow[] {
    if (!this.options.verifier) return [];
    return tasks.filter(isCompletedButUnverifiedTeamTask);
  }

  private reopenedTasks(tasks: readonly TeamTaskRow[]): TeamTaskRow[] {
    if (!this.options.verifier) return [];
    return tasks.filter(isReopenedAfterFailedVerification);
  }

  private pendingMergeTasks(tasks: readonly TeamTaskRow[]): TeamTaskRow[] {
    return tasks.filter((task) => verificationAcceptedPendingMerge(task));
  }

  private now(): TimestampMs {
    return this.options.now ? this.options.now() : timestampNow();
  }

  private id(prefix: string): string {
    const create = this.options.createId ?? defaultCreateId;
    return create(prefix);
  }

  private async publishRunStarted(
    input: TeamExecutionRunInput,
    sessionState: SessionState,
    team: TeamRow,
    runId: string,
    options: { maxCycles: number; timeoutMs: number; pollIntervalMs: number; maxConcurrentDispatches: number },
  ): Promise<void> {
    await this.appendRunEvent(input, sessionState, team, "team.run_started", {
      teamId: input.teamId,
      runId,
      mode: input.mode ?? "background",
      once: input.once === true,
      maxCycles: options.maxCycles,
      timeoutMs: options.timeoutMs,
      pollIntervalMs: options.pollIntervalMs,
      maxConcurrentDispatches: options.maxConcurrentDispatches,
    });
  }

  private async publishRunProgress(
    input: TeamExecutionRunInput,
    sessionState: SessionState,
    team: TeamRow,
    runId: string,
    summary: TeamExecutionRunSummary,
    phase: TeamRunLifecyclePhase,
    stopReason?: TeamRunStopReason,
  ): Promise<void> {
    const payload: {
      teamId: TeamId;
      runId: string;
      cycle: number;
      phase: TeamRunLifecyclePhase;
      counts: TeamRunSummaryCounts;
      stopReason?: TeamRunStopReason;
    } = {
      teamId: input.teamId,
      runId,
      cycle: summary.cycles,
      phase,
      counts: runSummaryCounts(summary),
    };
    if (stopReason) payload.stopReason = stopReason;
    await this.appendRunEvent(input, sessionState, team, "team.run_progress", payload);
  }

  private async publishRunCompleted(
    input: TeamExecutionRunInput,
    sessionState: SessionState,
    team: TeamRow,
    runId: string,
    summary: TeamExecutionRunSummary,
  ): Promise<void> {
    await this.appendRunEvent(input, sessionState, team, "team.run_completed", {
      teamId: input.teamId,
      runId,
      cycles: summary.cycles,
      stopReason: summary.stopReason,
      startedAt: summary.startedAt,
      endedAt: summary.endedAt,
      counts: runSummaryCounts(summary),
    });
  }

  private async appendRunEvent<TType extends ChiliEvent["type"], TPayload>(
    input: TeamExecutionRunInput,
    sessionState: SessionState,
    team: TeamRow,
    type: TType,
    payload: TPayload,
  ): Promise<void> {
    if (!this.options.events) return;
    const event: EventEnvelope<TType, TPayload> = {
      id: this.id("event"),
      type,
      time: this.now(),
      payload,
    };
    const sessionId = sessionState.sessionId ?? input.sessionId ?? team.sessionId;
    if (sessionId) event.sessionId = sessionId;
    const threadId = sessionState.threadId ?? input.threadId;
    if (threadId) event.threadId = threadId;
    await this.options.events.append(event as ChiliEvent);
  }

  private sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
    const delay = Math.max(0, ms);
    if (delay === 0 || signal?.aborted) return Promise.resolve();
    if (this.options.sleep) return this.options.sleep(delay, signal);
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, delay);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}

function normalizeMaxConcurrentDispatches(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_CONCURRENT_DISPATCHES;
  if (!Number.isInteger(value) || value <= 0) return DEFAULT_MAX_CONCURRENT_DISPATCHES;
  return Math.min(value, MAX_CONCURRENT_DISPATCHES);
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function dispatchReservationsForRunningTasks(tasks: readonly TeamTaskRow[]): DispatchReservations {
  const reservations: DispatchReservations = {
    owners: new Set<AgentPath>(),
    writeScopes: [],
  };
  for (const task of tasks) {
    if (task.status !== "in_progress") continue;
    if (task.ownerPath) reservations.owners.add(task.ownerPath);
    const writeScope = teamTaskWriteScope(task);
    if (writeScope.length === 0) continue;
    const reservation: TeamDispatchWriteReservation = {
      taskId: task.id,
      writeScope,
    };
    if (task.ownerPath) reservation.ownerPath = task.ownerPath;
    reservations.writeScopes.push(reservation);
  }
  return reservations;
}

function selectDispatchOwner(
  task: TeamTaskRow,
  members: readonly TeamMemberRow[],
  reservations: DispatchReservations,
): { ownerPath: AgentPath; reason?: never } | { ownerPath?: never; reason: TeamExecutionSkipReason } {
  if (members.length === 0) return { reason: "missing_member" };
  const writeScope = teamTaskWriteScope(task);
  const requiredTools = teamTaskRequiredTools(task);
  if (writeScope.length === 0 && requiredTools.length === 0) return { reason: "missing_owner" };
  let sawScopeCandidate = false;
  let sawBusyCandidate = false;
  const candidates = [...members].sort((left, right) => memberDispatchRank(left) - memberDispatchRank(right));

  for (const member of candidates) {
    if (!scopeAllowsAll(member.writeScope, writeScope) || !toolScopeAllowsAll(member.toolScope, requiredTools)) continue;
    sawScopeCandidate = true;
    if (member.status === "closed" || member.status === "blocked") {
      sawBusyCandidate = true;
      continue;
    }
    if (member.status === "running" && member.currentTaskId !== task.id) {
      sawBusyCandidate = true;
      continue;
    }
    if (reservations.owners.has(member.path)) {
      sawBusyCandidate = true;
      continue;
    }
    return { ownerPath: member.path };
  }

  if (sawBusyCandidate) return { reason: "member_unavailable" };
  if (!sawScopeCandidate && (writeScope.length > 0 || requiredTools.length > 0)) return { reason: "scope_mismatch" };
  return { reason: "missing_owner" };
}

function memberDispatchRank(member: TeamMemberRow): number {
  return member.role.trim().toLowerCase() === "leader" ? 1 : 0;
}

function reserveDispatchResources(
  task: TeamTaskRow,
  reservations: DispatchReservations,
): { allowed: true } | { allowed: false; reason: TeamExecutionSkipReason } {
  if (task.ownerPath && reservations.owners.has(task.ownerPath)) {
    return { allowed: false, reason: "member_unavailable" };
  }

  const writeScope = teamTaskWriteScope(task);
  if (writeScope.length > 0 && reservations.writeScopes.some((item) => scopesOverlap(writeScope, item.writeScope))) {
    return { allowed: false, reason: "write_conflict" };
  }

  if (task.ownerPath) reservations.owners.add(task.ownerPath);
  if (writeScope.length > 0) {
    const reservation: TeamDispatchWriteReservation = {
      taskId: task.id,
      writeScope,
    };
    if (task.ownerPath) reservation.ownerPath = task.ownerPath;
    reservations.writeScopes.push(reservation);
  }
  return { allowed: true };
}

function teamTaskWriteScope(task: TeamTaskRow): string[] {
  return metadataStringArray(task.metadata, ["writeScope", "write_scope", "writeScopes", "write_scopes"]) ?? [];
}

function teamTaskRequiredTools(task: TeamTaskRow): string[] {
  return metadataStringArray(task.metadata, ["requiredTools", "required_tools", "toolScope", "tool_scope"]) ?? [];
}

function metadataStringArray(metadata: Record<string, unknown> | undefined, keys: readonly string[]): string[] | undefined {
  if (!metadata) return undefined;
  for (const key of keys) {
    const value = metadata[key];
    if (!Array.isArray(value)) continue;
    const items = value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
    return items.length > 0 ? items : [];
  }
  return undefined;
}

function scopeAllowsAll(allowed: readonly string[] | undefined, required: readonly string[] | undefined): boolean {
  if (!required || required.length === 0) return true;
  if (!allowed) return true;
  if (allowed.length === 0) return false;
  return required.every((item) => allowed.some((scope) => pathScopeContains(scope, item)));
}

function toolScopeAllowsAll(allowed: readonly string[] | undefined, required: readonly string[] | undefined): boolean {
  if (!required || required.length === 0) return true;
  if (!allowed) return true;
  if (allowed.length === 0) return false;
  const normalizedAllowed = allowed.map(normalizeToolName);
  return required.every((item) => normalizedAllowed.includes("*") || normalizedAllowed.includes(normalizeToolName(item)));
}

function normalizeToolName(value: string): string {
  switch (value.trim().toLowerCase()) {
    case "shell":
    case "run":
      return "bash";
    case "write_file":
      return "write";
    default:
      return value.trim().toLowerCase();
  }
}

function scopesOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some((leftItem) => right.some((rightItem) => pathScopeContains(leftItem, rightItem) || pathScopeContains(rightItem, leftItem)));
}

function pathScopeContains(scope: string, item: string): boolean {
  const normalizedScope = normalizePathScope(scope);
  const normalizedItem = normalizePathScope(item);
  if (normalizedScope === "*" || normalizedScope === "." || normalizedScope === "/") return true;
  return normalizedItem === normalizedScope || normalizedItem.startsWith(`${normalizedScope}/`);
}

function normalizePathScope(value: string): string {
  let normalized = value.trim().replaceAll("\\", "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  while (normalized.length > 1 && normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  return normalized || ".";
}

function incompleteDependencies(task: TeamTaskRow, tasks: readonly TeamTaskRow[], requireAccepted = false): TaskId[] {
  if (task.dependsOn.length === 0) return [];
  const byId = new Map(tasks.map((item) => [item.id, item]));
  return task.dependsOn.filter((taskId) => {
    const dependency = byId.get(taskId);
    if (!dependency || dependency.status !== "completed") return true;
    return requireAccepted && !isAcceptedTeamTask(dependency);
  });
}

function runnablePendingTasks(
  state: TeamExecutionState,
  input: TeamExecutionRunInput,
  sessionState: SessionState,
  canCreateSession: boolean,
  requireAcceptedDependencies = false,
): TeamTaskRow[] {
  const reservations = dispatchReservationsForRunningTasks(state.tasks);
  return state.tasks.filter((task) => {
    if (task.status !== "pending") return false;
    if (incompleteDependencies(task, state.tasks, requireAcceptedDependencies).length > 0) return false;
    const ownerPath = task.ownerPath ?? selectDispatchOwner(task, state.members, reservations).ownerPath;
    if (!ownerPath) return false;
    if (!Boolean(sessionState.sessionId ?? input.sessionId ?? task.sessionId ?? state.team.sessionId ?? canCreateSession)) return false;
    const member = state.members.find((item) => item.path === ownerPath);
    if (!member) return true;
    return member.status !== "closed" && member.status !== "blocked" && !(member.status === "running" && member.currentTaskId !== task.id);
  });
}

function runningTasks(tasks: readonly TeamTaskRow[]): TeamTaskRow[] {
  return tasks.filter((task) => task.status === "in_progress");
}

function runningTaskSummary(task: TeamTaskRow): TeamExecutionRunningTask {
  const summary: TeamExecutionRunningTask = {
    teamId: task.teamId,
    taskId: task.id,
    title: task.title,
  };
  if (task.ownerPath) summary.ownerPath = task.ownerPath;
  const agentTaskId = dispatchAgentTaskId(task.metadata);
  if (agentTaskId) summary.agentTaskId = agentTaskId;
  return summary;
}

function finalTaskSummary(task: TeamTaskRow, agentTaskId: TaskId | undefined): TeamExecutionFinalTask | undefined {
  if (!isFinalStatus(task.status)) return undefined;
  const summary: TeamExecutionFinalTask = {
    teamId: task.teamId,
    taskId: task.id,
    status: task.status,
  };
  if (task.ownerPath) summary.ownerPath = task.ownerPath;
  if (task.summary) summary.summary = task.summary;
  if (task.error) summary.error = task.error;
  const resolvedAgentTaskId = agentTaskId ?? dispatchAgentTaskId(task.metadata);
  if (resolvedAgentTaskId) summary.agentTaskId = resolvedAgentTaskId;
  return summary;
}

function verificationSummary(result: TeamTaskVerifierVerifiedResult): TeamExecutionVerificationTask {
  const item: TeamExecutionVerificationTask = {
    teamId: result.teamTask.teamId,
    taskId: result.teamTask.id,
    status: result.status === "passed" ? "passed" : "failed",
  };
  if (result.teamTask.ownerPath) item.ownerPath = result.teamTask.ownerPath;
  if (result.feedback) item.feedback = result.feedback;
  if (result.verifierTask?.taskId) item.verifierTaskId = result.verifierTask.taskId;
  return item;
}

function mergeSummary(result: TeamMergeTaskResult): TeamExecutionMergeTask {
  const item: TeamExecutionMergeTask = {
    teamId: result.teamTask.teamId,
    taskId: result.teamTask.id,
    status: result.status,
  };
  if (result.teamTask.ownerPath) item.ownerPath = result.teamTask.ownerPath;
  if (result.diffSummary) item.diffSummary = result.diffSummary;
  if (result.error) item.error = result.error;
  if (result.conflicts) item.conflicts = result.conflicts;
  return item;
}

function mergeSkippedSummary(result: TeamMergeTaskSkipped): TeamExecutionMergeSkippedTask {
  const item: TeamExecutionMergeSkippedTask = {
    teamId: result.teamTask.teamId,
    taskId: result.teamTask.id,
    reason: result.reason,
  };
  if (result.teamTask.ownerPath) item.ownerPath = result.teamTask.ownerPath;
  if (result.error) item.error = result.error;
  return item;
}

function verificationAcceptedPendingMerge(task: TeamTaskRow): boolean {
  return isAcceptedTeamTask(task) && taskMergeMetadata(task.metadata)?.status === "pending";
}

function isFinalStatus(status: TeamTaskStatus): status is Extract<TeamTaskStatus, "completed" | "failed" | "cancelled"> {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function dispatchAgentTaskId(metadata: Record<string, unknown> | undefined): TaskId | undefined {
  const dispatch = metadata?.chiliTeamDispatch;
  if (!isRecord(dispatch) || typeof dispatch.agentTaskId !== "string") return undefined;
  return dispatch.agentTaskId as TaskId;
}

function dispatchSkipReason(reason: TeamTaskDispatchResult["reason"]): TeamExecutionSkipReason {
  if (
    reason === "already_claimed" ||
    reason === "already_resolved" ||
    reason === "blocked" ||
    reason === "missing_owner" ||
    reason === "missing_session" ||
    reason === "missing_member" ||
    reason === "member_unavailable" ||
    reason === "scope_mismatch" ||
    reason === "write_conflict"
  ) {
    return reason;
  }
  return "blocked";
}

function syncSkipReason(reason: TeamTaskSyncResult["reason"]): TeamExecutionSkipReason | undefined {
  if (!reason) return undefined;
  if (
    reason === "not_dispatched" ||
    reason === "agent_task_not_found" ||
    reason === "team_already_final"
  ) {
    return reason;
  }
  return undefined;
}

function verifierSkipReason(reason: TeamTaskVerifierSkipReason): TeamExecutionSkipReason {
  if (reason === "missing_owner" || reason === "missing_session") return reason;
  if (reason === "already_passed") return "already_resolved";
  return "blocked";
}

function pushUniqueDispatch(items: TeamExecutionDispatchedTask[], item: TeamExecutionDispatchedTask): void {
  const index = items.findIndex((existing) => existing.taskId === item.taskId);
  if (index >= 0) items[index] = item;
  else items.push(item);
}

function pushUniqueFinal(items: TeamExecutionFinalTask[], item: TeamExecutionFinalTask): void {
  const index = items.findIndex((existing) => existing.taskId === item.taskId);
  if (index >= 0) items[index] = item;
  else items.push(item);
}

function pushUniqueSkipped(items: TeamExecutionSkippedTask[], item: TeamExecutionSkippedTask): void {
  const index = items.findIndex((existing) => existing.taskId === item.taskId && existing.reason === item.reason);
  if (index >= 0) items[index] = item;
  else items.push(item);
}

function pushUniqueVerification(items: TeamExecutionVerificationTask[], item: TeamExecutionVerificationTask): void {
  const index = items.findIndex((existing) => existing.taskId === item.taskId);
  if (index >= 0) items[index] = item;
  else items.push(item);
}

function pushUniqueMerge(items: TeamExecutionMergeTask[], item: TeamExecutionMergeTask): void {
  const index = items.findIndex((existing) => existing.taskId === item.taskId);
  if (index >= 0) items[index] = item;
  else items.push(item);
}

function pushUniqueMergeSkipped(items: TeamExecutionMergeSkippedTask[], item: TeamExecutionMergeSkippedTask): void {
  const index = items.findIndex((existing) => existing.taskId === item.taskId && existing.reason === item.reason);
  if (index >= 0) items[index] = item;
  else items.push(item);
}

function removeSkipped(summary: TeamExecutionRunSummary, taskId: TaskId): void {
  summary.blocked = summary.blocked.filter((item) => item.taskId !== taskId);
  summary.skipped = summary.skipped.filter((item) => item.taskId !== taskId);
}

function remainingDelay(timeoutMs: number, startedMonotonic: number): number {
  return Math.max(0, timeoutMs - (Date.now() - startedMonotonic));
}

function runSummaryCounts(summary: TeamExecutionRunSummary): TeamRunSummaryCounts {
  return {
    dispatched: summary.dispatched.length,
    completed: summary.completed.length,
    accepted: summary.accepted.length,
    reopened: summary.reopened.length,
    merged: summary.merged.length,
    mergeFailed: summary.mergeFailed.length,
    mergeConflicted: summary.mergeConflicted.length,
    mergeSkipped: summary.mergeSkipped.length,
    failed: summary.failed.length,
    blocked: summary.blocked.length,
    skipped: summary.skipped.length,
    stillRunning: summary.stillRunning.length,
    errors: summary.errors.length,
  };
}

function controlStopReason(
  input: TeamExecutionRunInput,
  startedMonotonic: number,
  timeoutMs: number,
): Extract<TeamExecutionStopReason, "aborted" | "timeout"> | undefined {
  if (input.signal?.aborted) return "aborted";
  if (Date.now() - startedMonotonic >= timeoutMs) return "timeout";
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isAbortError(error: unknown): boolean {
  const err = toError(error);
  return err.name === "AbortError" || err.message.toLowerCase().includes("aborted");
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function defaultCreateId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}
