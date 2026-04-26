import type {
  AgentPath,
  AgentRunId,
  SessionId,
  TaskId,
  TeamId,
  TeamTaskStatus,
  ThreadId,
  TimestampMs,
} from "@chili/protocol";
import { timestampNow } from "@chili/protocol";
import type { AgentTaskRow, SubagentProjectionStore, TeamTaskMutationResult, TeamTaskRow } from "@chili/store";
import type { LocalSubagentMode, LocalSubagentTaskInput, LocalSubagentTaskResult } from "./subagent.js";
import { TeamTaskNotFoundError, type TeamControlService } from "./team.js";

const DISPATCH_METADATA_KEY = "chiliTeamDispatch";

export interface TeamTaskDispatchServiceOptions {
  teams: TeamControlService;
  subagents: TeamTaskSubagentRunner;
  store: SubagentProjectionStore;
  cwd: string;
  now?: () => TimestampMs;
}

export interface TeamTaskSubagentRunner {
  spawnTask(input: LocalSubagentTaskInput): Promise<LocalSubagentTaskResult>;
}

export interface TeamTaskDispatchInput {
  teamId: TeamId;
  taskId: TaskId;
  ownerPath?: AgentPath;
  sessionId?: SessionId;
  threadId?: ThreadId;
  cwd?: string;
  mode?: LocalSubagentMode;
  prompt?: string;
  signal?: AbortSignal;
}

export interface TeamTaskSyncInput {
  teamId: TeamId;
  taskId: TaskId;
  sessionId?: SessionId;
  threadId?: ThreadId;
}

export interface TeamTaskReconcileInput {
  teamId?: TeamId;
  sessionId?: SessionId;
  threadId?: ThreadId;
  limit?: number;
}

export interface TeamTaskAgentBinding {
  agentTaskId: TaskId;
  agentPath: AgentPath;
  runId: AgentRunId;
  childSessionId: SessionId;
  childThreadId: ThreadId;
  mode: LocalSubagentMode;
  dispatchedAt: number;
  agentStatus: LocalSubagentTaskResult["status"] | AgentTaskRow["status"];
  syncedAt?: number;
}

export type TeamTaskDispatchStatus = "running" | "completed" | "failed" | "cancelled" | "skipped";

export interface TeamTaskDispatchResult {
  status: TeamTaskDispatchStatus;
  teamTask: TeamTaskRow;
  agentTask?: LocalSubagentTaskResult;
  reason?: TeamTaskMutationResult["reason"] | "missing_owner" | "missing_session";
}

export interface TeamTaskSyncResult {
  applied: boolean;
  teamTask: TeamTaskRow;
  agentTask?: AgentTaskRow;
  reason?: "not_dispatched" | "agent_task_not_found" | "agent_running" | "team_already_final";
}

export interface TeamTaskReconcileError {
  teamId: TeamId;
  taskId: TaskId;
  error: string;
}

export interface TeamTaskReconcileResult {
  scanned: number;
  synced: TeamTaskSyncResult[];
  skipped: TeamTaskSyncResult[];
  errors: TeamTaskReconcileError[];
}

export class TeamTaskDispatchService {
  constructor(private readonly options: TeamTaskDispatchServiceOptions) {}

  async dispatchTask(input: TeamTaskDispatchInput): Promise<TeamTaskDispatchResult> {
    const [team, task] = await Promise.all([this.requireTeam(input.teamId), this.requireTeamTask(input.teamId, input.taskId)]);
    if (isFinalTeamTaskStatus(task.status)) {
      return { status: "skipped", reason: "already_resolved", teamTask: task };
    }

    const ownerPath = input.ownerPath ?? task.ownerPath;
    if (!ownerPath) return { status: "skipped", reason: "missing_owner", teamTask: task };

    const parentSessionId = input.sessionId ?? task.sessionId ?? team.sessionId;
    if (!parentSessionId) return { status: "skipped", reason: "missing_session", teamTask: task };

    const claim = await this.options.teams.claimTask({
      teamId: input.teamId,
      taskId: input.taskId,
      ownerPath,
      claimedBy: ownerPath,
      sessionId: parentSessionId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
    });
    if (!claim.applied) {
      return {
        status: "skipped",
        reason: claim.reason,
        teamTask: claim.task ?? task,
      };
    }

    const claimedTask = claim.task ?? (await this.requireTeamTask(input.teamId, input.taskId));
    try {
      const mode = input.mode ?? "background";
      const spawnInput: LocalSubagentTaskInput = {
        parentSessionId,
        ...(input.threadId ? { parentThreadId: input.threadId } : {}),
        parentPath: ownerPath,
        cwd: input.cwd ?? this.options.cwd,
        taskName: claimedTask.title,
        prompt: input.prompt ?? teamTaskPrompt(claimedTask, ownerPath),
        mode,
      };
      if (input.signal) spawnInput.signal = input.signal;
      const agentTask = await this.options.subagents.spawnTask(spawnInput);

      const updateInput = {
        task: claimedTask,
        agentTask,
        mode,
        sessionId: parentSessionId,
      };
      const teamTask = await this.updateTeamTaskFromAgentResult(
        input.threadId ? { ...updateInput, threadId: input.threadId } : updateInput,
      );
      return { status: agentTask.status, teamTask, agentTask };
    } catch (error) {
      const err = toError(error);
      const teamTask = await this.options.teams.updateTask({
        teamId: input.teamId,
        taskId: input.taskId,
        status: isAbortError(err) ? "cancelled" : "failed",
        error: err.message,
        metadata: mergeDispatchMetadata(claimedTask.metadata, {
          agentStatus: isAbortError(err) ? "cancelled" : "failed",
          syncedAt: Number(this.now()),
        }),
        sessionId: parentSessionId,
        ...(input.threadId ? { threadId: input.threadId } : {}),
      });
      return { status: isAbortError(err) ? "cancelled" : "failed", teamTask };
    }
  }

  async syncTask(input: TeamTaskSyncInput): Promise<TeamTaskSyncResult> {
    const teamTask = await this.requireTeamTask(input.teamId, input.taskId);
    const binding = dispatchBinding(teamTask.metadata);
    if (!binding) return { applied: false, reason: "not_dispatched", teamTask };

    const agentTask = await this.options.store.agentTask(binding.agentTaskId);
    if (!agentTask) return { applied: false, reason: "agent_task_not_found", teamTask };
    if (!isFinalAgentTaskStatus(agentTask.status)) {
      return { applied: false, reason: "agent_running", teamTask, agentTask };
    }
    if (isFinalTeamTaskStatus(teamTask.status)) {
      return { applied: false, reason: "team_already_final", teamTask, agentTask };
    }

    const updated = await this.options.teams.updateTask({
      teamId: input.teamId,
      taskId: input.taskId,
      status: teamStatusFromAgentStatus(agentTask.status),
      ...(agentTask.summary ? { summary: agentTask.summary } : {}),
      ...(agentTask.error ? { error: agentTask.error } : {}),
      metadata: mergeDispatchMetadata(teamTask.metadata, {
        ...binding,
        agentStatus: agentTask.status,
        syncedAt: Number(this.now()),
      }),
      ...(input.sessionId ?? teamTask.sessionId ? { sessionId: input.sessionId ?? teamTask.sessionId } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
    });
    return { applied: true, teamTask: updated, agentTask };
  }

  async reconcileTasks(input: TeamTaskReconcileInput = {}): Promise<TeamTaskReconcileResult> {
    const limit = input.limit ?? 500;
    const result: TeamTaskReconcileResult = {
      scanned: 0,
      synced: [],
      skipped: [],
      errors: [],
    };

    const teams = input.teamId ? [await this.requireTeam(input.teamId)] : (await this.options.teams.listTeams()).filter((team) => team.status === "active");
    for (const team of teams) {
      const tasks = await this.options.teams.tasks(team.id);
      for (const task of tasks) {
        if (result.scanned >= limit) return result;
        if (task.status !== "in_progress") continue;
        if (!dispatchBinding(task.metadata)) continue;

        result.scanned++;
        try {
          const syncInput: TeamTaskSyncInput = {
            teamId: team.id,
            taskId: task.id,
          };
          const sessionId = input.sessionId ?? task.sessionId ?? team.sessionId;
          if (sessionId) syncInput.sessionId = sessionId;
          if (input.threadId) syncInput.threadId = input.threadId;
          const synced = await this.syncTask(syncInput);
          if (synced.applied) result.synced.push(synced);
          else result.skipped.push(synced);
        } catch (error) {
          result.errors.push({
            teamId: team.id,
            taskId: task.id,
            error: toError(error).message,
          });
        }
      }
    }
    return result;
  }

  private async updateTeamTaskFromAgentResult(input: {
    task: TeamTaskRow;
    agentTask: LocalSubagentTaskResult;
    mode: LocalSubagentMode;
    sessionId: SessionId;
    threadId?: ThreadId;
  }): Promise<TeamTaskRow> {
    const status = teamStatusFromAgentStatus(input.agentTask.status);
    const update: Parameters<TeamControlService["updateTask"]>[0] = {
      teamId: input.task.teamId,
      taskId: input.task.id,
      status,
      metadata: mergeDispatchMetadata(input.task.metadata, {
        agentTaskId: input.agentTask.taskId,
        agentPath: input.agentTask.path,
        runId: input.agentTask.runId,
        childSessionId: input.agentTask.childSessionId,
        childThreadId: input.agentTask.childThreadId,
        mode: input.mode,
        dispatchedAt: Number(this.now()),
        agentStatus: input.agentTask.status,
        ...(isFinalLocalSubagentStatus(input.agentTask.status) ? { syncedAt: Number(this.now()) } : {}),
      }),
      sessionId: input.sessionId,
    };
    if (input.threadId) update.threadId = input.threadId;
    if (input.agentTask.summary) update.summary = input.agentTask.summary;
    if (input.agentTask.error) update.error = input.agentTask.error.message;
    return this.options.teams.updateTask(update);
  }

  private async requireTeam(teamId: TeamId) {
    const team = (await this.options.teams.listTeams()).find((item) => item.id === teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);
    return team;
  }

  private async requireTeamTask(teamId: TeamId, taskId: TaskId): Promise<TeamTaskRow> {
    const task = (await this.options.teams.tasks(teamId)).find((item) => item.id === taskId);
    if (!task) throw new TeamTaskNotFoundError(teamId, taskId);
    return task;
  }

  private now(): TimestampMs {
    return this.options.now ? this.options.now() : timestampNow();
  }
}

function teamTaskPrompt(task: TeamTaskRow, ownerPath: AgentPath): string {
  return [
    `Team task: ${task.teamId}/${task.id}`,
    `Assigned member path: ${ownerPath}`,
    `Title: ${task.title}`,
    task.description ? `Description:\n${task.description}` : undefined,
    task.dependsOn.length > 0 ? `Dependencies: ${task.dependsOn.join(", ")}` : undefined,
    "",
    "Work the task to completion. Use team tools for progress notes when helpful. When complete, call complete_task for your local subagent task with a concise summary.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function dispatchBinding(metadata: Record<string, unknown> | undefined): TeamTaskAgentBinding | undefined {
  const value = metadata?.[DISPATCH_METADATA_KEY];
  if (!isRecord(value)) return undefined;
  if (
    typeof value.agentTaskId !== "string" ||
    typeof value.agentPath !== "string" ||
    typeof value.runId !== "string" ||
    typeof value.childSessionId !== "string" ||
    typeof value.childThreadId !== "string"
  ) {
    return undefined;
  }
  return value as unknown as TeamTaskAgentBinding;
}

function mergeDispatchMetadata(
  metadata: Record<string, unknown> | undefined,
  binding: Partial<TeamTaskAgentBinding>,
): Record<string, unknown> {
  const current = metadata ?? {};
  const previous = isRecord(current[DISPATCH_METADATA_KEY]) ? current[DISPATCH_METADATA_KEY] : {};
  return {
    ...current,
    [DISPATCH_METADATA_KEY]: pruneUndefined({
      ...previous,
      ...binding,
    }),
  };
}

function teamStatusFromAgentStatus(status: LocalSubagentTaskResult["status"] | AgentTaskRow["status"]): TeamTaskStatus {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return "in_progress";
}

function isFinalTeamTaskStatus(status: TeamTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isFinalAgentTaskStatus(status: AgentTaskRow["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isFinalLocalSubagentStatus(status: LocalSubagentTaskResult["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pruneUndefined<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) output[key] = item;
  }
  return output as T;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isAbortError(error: Error): boolean {
  return error.name === "AbortError" || error.message.toLowerCase().includes("aborted");
}
