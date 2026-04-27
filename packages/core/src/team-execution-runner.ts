import type { AgentPath, SessionId, TaskId, TeamId, TeamTaskStatus, ThreadId, TimestampMs } from "@chili/protocol";
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
  TeamTaskVerifierSkipReason,
  TeamTaskVerifierSweepInput,
  TeamTaskVerifierSweepResult,
  TeamTaskVerifierVerifiedResult,
} from "./team-verifier.js";
import { isAcceptedTeamTask, isCompletedButUnverifiedTeamTask, isReopenedAfterFailedVerification } from "./team-verifier.js";
import type { TeamControlService } from "./team.js";

export interface TeamExecutionRunnerOptions {
  teams: TeamControlService;
  dispatcher: TeamTaskDispatchService;
  verifier?: TeamTaskVerifier;
  cwd: string;
  now?: () => TimestampMs;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  createSession?: (input: TeamExecutionSessionRequest) => Promise<TeamExecutionSession>;
}

export interface TeamTaskVerifier {
  verifyCompletedTasks(input: TeamTaskVerifierSweepInput): Promise<TeamTaskVerifierSweepResult>;
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
  signal?: AbortSignal;
}

export interface TeamExecutionRunSummary {
  teamId: TeamId;
  cycles: number;
  stopReason: TeamExecutionStopReason;
  startedAt: number;
  endedAt: number;
  dispatched: TeamExecutionDispatchedTask[];
  completed: TeamExecutionFinalTask[];
  accepted: TeamExecutionFinalTask[];
  reopened: TeamExecutionVerificationTask[];
  failed: TeamExecutionFinalTask[];
  blocked: TeamExecutionSkippedTask[];
  skipped: TeamExecutionSkippedTask[];
  stillRunning: TeamExecutionRunningTask[];
  errors: TeamExecutionError[];
}

export type TeamExecutionStopReason = "drained" | "once" | "max_cycles" | "timeout" | "aborted" | "team_inactive";

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

const DEFAULT_MAX_CYCLES = 50;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

export class TeamExecutionRunner {
  constructor(private readonly options: TeamExecutionRunnerOptions) {}

  async run(input: TeamExecutionRunInput): Promise<TeamExecutionRunSummary> {
    const startedAt = Number(this.now());
    const maxCycles = input.once ? 1 : input.maxCycles ?? DEFAULT_MAX_CYCLES;
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
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
      dispatched: [],
      completed: [],
      accepted: [],
      reopened: [],
      failed: [],
      blocked: [],
      skipped: [],
      stillRunning: [],
      errors: [],
    };

    const initialState = await this.loadState(input.teamId);
    if (initialState.team.status !== "active") {
      summary.stopReason = "team_inactive";
      summary.endedAt = Number(this.now());
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
      if (postReconcileStop) {
        summary.stopReason = postReconcileStop;
        break;
      }

      let state = await this.loadState(input.teamId);
      if (state.team.status !== "active") {
        summary.stopReason = "team_inactive";
        break;
      }
      const postLoadStop = controlStopReason(input, startedMonotonic, timeoutMs);
      if (postLoadStop) {
        summary.stopReason = postLoadStop;
        break;
      }

      const verified = await this.verifyCompletedTasks(input, summary, sessionState);
      this.collectVerification(verified, summary);
      const postVerifyStop = controlStopReason(input, startedMonotonic, timeoutMs);
      if (postVerifyStop) {
        summary.stopReason = postVerifyStop;
        break;
      }
      if (verified && (verified.verified.length > 0 || verified.skipped.length > 0)) {
        state = await this.loadState(input.teamId);
      }

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

        if (!task.ownerPath) {
          pushUniqueSkipped(summary.skipped, {
            teamId: input.teamId,
            taskId: task.id,
            reason: "missing_owner",
          });
          continue;
        }

        if (!this.currentSessionId(state.team, task, sessionState, input)) {
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
              ownerPath: task.ownerPath,
              reason: "missing_session",
            });
            continue;
          }
          if (controlStopReason(input, startedMonotonic, timeoutMs)) break;
        }

        try {
          const dispatchInput: Parameters<TeamTaskDispatchService["dispatchTask"]>[0] = {
            teamId: input.teamId,
            taskId: task.id,
            mode: input.mode ?? "background",
            cwd: input.cwd ?? this.options.cwd,
          };
          const sessionId = sessionState.sessionId ?? task.sessionId ?? state.team.sessionId;
          if (sessionId) dispatchInput.sessionId = sessionId;
          const threadId = sessionState.threadId ?? input.threadId;
          if (threadId) dispatchInput.threadId = threadId;
          if (input.signal) dispatchInput.signal = input.signal;

          const dispatched = await this.options.dispatcher.dispatchTask(dispatchInput);
          this.collectDispatch(dispatched, summary);
          if (controlStopReason(input, startedMonotonic, timeoutMs)) break;
        } catch (error) {
          summary.errors.push({
            teamId: input.teamId,
            taskId: task.id,
            error: toError(error).message,
          });
        }
      }

      const postScanStop = controlStopReason(input, startedMonotonic, timeoutMs);
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
      if (stillRunning.length === 0 && runnable.length === 0 && unverified.length === 0 && reopened.length === 0) {
        summary.stopReason = "drained";
        break;
      }

      if (stillRunning.length > 0 && !input.signal?.aborted) {
        await this.sleep(Math.min(pollIntervalMs, remainingDelay(timeoutMs, startedMonotonic)), input.signal);
      }
    }

    const finalState = await this.loadState(input.teamId);
    summary.stillRunning = runningTasks(finalState.tasks).map((task) => runningTaskSummary(task));
    summary.accepted = this.acceptedTasks(finalState.tasks).map((task) => finalTaskSummary(task, undefined)).filter(isDefined);
    summary.endedAt = Number(this.now());
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

  private now(): TimestampMs {
    return this.options.now ? this.options.now() : timestampNow();
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
  return state.tasks.filter((task) => {
    if (task.status !== "pending") return false;
    if (!task.ownerPath) return false;
    if (incompleteDependencies(task, state.tasks, requireAcceptedDependencies).length > 0) return false;
    if (!Boolean(sessionState.sessionId ?? input.sessionId ?? task.sessionId ?? state.team.sessionId ?? canCreateSession)) return false;
    const member = state.members.find((item) => item.path === task.ownerPath);
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

function removeSkipped(summary: TeamExecutionRunSummary, taskId: TaskId): void {
  summary.blocked = summary.blocked.filter((item) => item.taskId !== taskId);
  summary.skipped = summary.skipped.filter((item) => item.taskId !== taskId);
}

function remainingDelay(timeoutMs: number, startedMonotonic: number): number {
  return Math.max(0, timeoutMs - (Date.now() - startedMonotonic));
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

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
