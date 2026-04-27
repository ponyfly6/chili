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
import type {
  AgentTaskRow,
  SubagentProjectionStore,
  TeamMemberRow,
  TeamTaskMutationResult,
  TeamTaskRow,
} from "@chili/store";
import type { LocalSubagentMode, LocalSubagentTaskInput, LocalSubagentTaskResult } from "./subagent.js";
import { TeamTaskNotFoundError, type TeamControlService } from "./team.js";
import type { TeamWorktreeEnsureInput, TeamWorktreeEnsureResult } from "./team-worktree.js";
import {
  SCOPED_WORKER_BASE_TOOLS,
  SCOPED_WORKER_EXECUTE_TOOLS,
  SCOPED_WORKER_WRITE_TOOLS,
  type WorkerToolPolicyTemplate,
} from "./worker-policy.js";

const DISPATCH_METADATA_KEY = "chiliTeamDispatch";

export interface TeamTaskDispatchServiceOptions {
  teams: TeamControlService;
  subagents: TeamTaskSubagentRunner;
  store: SubagentProjectionStore;
  worktrees?: TeamTaskWorktreeManager;
  cwd: string;
  now?: () => TimestampMs;
}

export interface TeamTaskSubagentRunner {
  spawnTask(input: LocalSubagentTaskInput): Promise<LocalSubagentTaskResult>;
}

export interface TeamTaskWorktreeManager {
  ensureTaskWorktree(input: TeamWorktreeEnsureInput): Promise<TeamWorktreeEnsureResult>;
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
  policy?: TeamTaskDispatchPolicyMetadata;
}

export interface TeamTaskDispatchConflict {
  taskId: TaskId;
  ownerPath?: AgentPath;
  writeScope: string[];
}

export interface TeamTaskDispatchPolicyMetadata {
  allowed: boolean;
  reason?: TeamTaskDispatchPolicyReason;
  writeScope?: string[];
  executeScope?: string[];
  requiredTools?: string[];
  allowedTools?: string[];
  memberWriteScope?: string[];
  memberToolScope?: string[];
  conflicts?: TeamTaskDispatchConflict[];
  checkedAt: number;
}

export type TeamTaskDispatchStatus = "running" | "completed" | "failed" | "cancelled" | "skipped";
export type TeamTaskDispatchPolicyReason = "missing_member" | "member_unavailable" | "scope_mismatch" | "write_conflict";

export interface TeamTaskDispatchResult {
  status: TeamTaskDispatchStatus;
  teamTask: TeamTaskRow;
  agentTask?: LocalSubagentTaskResult;
  reason?: TeamTaskMutationResult["reason"] | "missing_owner" | "missing_session" | TeamTaskDispatchPolicyReason;
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

    const dispatchPolicy = await this.dispatchPolicy({
      teamId: input.teamId,
      task,
      ownerPath,
    });
    if (!dispatchPolicy.allowed) {
      const shouldBlockTask = dispatchPolicy.reason !== "member_unavailable";
      const updateInput: Parameters<TeamControlService["updateTask"]>[0] = {
        teamId: input.teamId,
        taskId: input.taskId,
        metadata: mergeDispatchMetadata(task.metadata, { policy: dispatchPolicy }),
        sessionId: parentSessionId,
      };
      if (shouldBlockTask) updateInput.status = "blocked";
      if (shouldBlockTask && dispatchPolicy.reason) updateInput.error = dispatchPolicy.reason;
      if (input.threadId) updateInput.threadId = input.threadId;
      const blockedTask = await this.options.teams.updateTask(updateInput);
      return { status: "skipped", reason: dispatchPolicy.reason, teamTask: blockedTask };
    }

    let dispatchTask = task;
    let worktree: TeamWorktreeEnsureResult | undefined;
    if (this.options.worktrees && taskNeedsWorktree(task)) {
      try {
        worktree = await this.ensureWorktree({
          teamId: input.teamId,
          taskId: input.taskId,
          cwd: input.cwd ?? this.options.cwd,
          sessionId: parentSessionId,
          ...(input.threadId ? { threadId: input.threadId } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        });
        dispatchTask = worktree.task;
      } catch (error) {
        if (isSignalAbort(error, input.signal)) throw error;
        const err = toError(error);
        const blockedTask = await this.options.teams.updateTask({
          teamId: input.teamId,
          taskId: input.taskId,
          status: "blocked",
          error: `worktree_failed: ${err.message}`,
          metadata: mergeDispatchMetadata(task.metadata, { policy: dispatchPolicy }),
          sessionId: parentSessionId,
          ...(input.threadId ? { threadId: input.threadId } : {}),
        });
        return { status: "skipped", reason: "blocked", teamTask: blockedTask };
      }
      throwIfAborted(input.signal);
    }

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
    const claimedMetadata = claimedTask.metadata ?? {};
    const taskForPrompt: TeamTaskRow = worktree && !claimedMetadata.worktree
      ? { ...claimedTask, metadata: dispatchTask.metadata ?? {} }
      : claimedTask;
    try {
      const mode = input.mode ?? "background";
      const taskCwd = worktree?.path ?? input.cwd ?? this.options.cwd;
      const spawnInput: LocalSubagentTaskInput = {
        parentSessionId,
        ...(input.threadId ? { parentThreadId: input.threadId } : {}),
        parentPath: ownerPath,
        cwd: taskCwd,
        taskName: taskForPrompt.title,
        prompt: input.prompt ?? teamTaskPrompt(taskForPrompt, ownerPath, dispatchPolicy, worktree?.path),
        mode,
        workerPolicy: workerPolicyForDispatch({
          teamId: input.teamId,
          taskId: input.taskId,
          memberPath: ownerPath,
          parentSessionId,
          dispatchPolicy,
        }),
      };
      if (input.signal) spawnInput.signal = input.signal;
      const agentTask = await this.options.subagents.spawnTask(spawnInput);
      const policyMetadata = dispatchPolicyForMetadata(dispatchPolicy);

      const updateInput = {
        task: taskForPrompt,
        agentTask,
        mode,
        sessionId: parentSessionId,
        ...(policyMetadata ? { policy: policyMetadata } : {}),
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

  private async ensureWorktree(input: TeamWorktreeEnsureInput): Promise<TeamWorktreeEnsureResult> {
    if (!this.options.worktrees) {
      throw new Error("Team worktree service is not configured");
    }
    return this.options.worktrees.ensureTaskWorktree(input);
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
    policy?: TeamTaskDispatchPolicyMetadata;
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
        ...(input.policy ? { policy: input.policy } : {}),
        ...(isFinalLocalSubagentStatus(input.agentTask.status) ? { syncedAt: Number(this.now()) } : {}),
      }),
      sessionId: input.sessionId,
    };
    if (input.threadId) update.threadId = input.threadId;
    if (input.agentTask.summary) update.summary = input.agentTask.summary;
    if (status === "completed" && input.task.error) update.error = "";
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

  private async dispatchPolicy(input: {
    teamId: TeamId;
    task: TeamTaskRow;
    ownerPath: AgentPath;
  }): Promise<TeamTaskDispatchPolicyMetadata> {
    const checkedAt = Number(this.now());
    const members = await this.options.teams.members(input.teamId);
    const member = members.find((item) => item.path === input.ownerPath);
    const taskWriteScope = metadataStringArray(input.task.metadata, ["writeScope", "write_scope", "writeScopes", "write_scopes"]);
    const executeScope = metadataStringArray(input.task.metadata, ["executeScope", "execute_scope", "executionScope", "execution_scope"]);
    const requiredTools = metadataStringArray(input.task.metadata, ["requiredTools", "required_tools", "toolScope", "tool_scope"]);
    const requiredToolNames = normalizedToolNames(requiredTools);
    const policyBase: TeamTaskDispatchPolicyMetadata = {
      allowed: true,
      checkedAt,
    };
    if (taskWriteScope) policyBase.writeScope = taskWriteScope;
    if (executeScope) policyBase.executeScope = executeScope;
    if (requiredTools) policyBase.requiredTools = requiredTools;
    if (member?.writeScope) policyBase.memberWriteScope = member.writeScope;
    if (member?.toolScope) policyBase.memberToolScope = member.toolScope;

    if (!member) {
      return { ...policyBase, allowed: false, reason: "missing_member" };
    }
    if (requiresExplicitScope(requiredToolNames, SCOPED_WORKER_WRITE_TOOLS, taskWriteScope)) {
      return { ...policyBase, allowed: false, reason: "scope_mismatch" };
    }
    if (requiresExplicitScope(requiredToolNames, SCOPED_WORKER_EXECUTE_TOOLS, executeScope)) {
      return { ...policyBase, allowed: false, reason: "scope_mismatch" };
    }
    if (member.status === "closed" || member.status === "blocked" || (member.status === "running" && member.currentTaskId !== input.task.id)) {
      return { ...policyBase, allowed: false, reason: "member_unavailable" };
    }
    if (!scopeAllowsAll(member.writeScope, taskWriteScope) || !toolScopeAllowsAll(member.toolScope, requiredTools)) {
      return { ...policyBase, allowed: false, reason: "scope_mismatch" };
    }

    const conflicts = await this.writeConflicts(input.teamId, input.task, taskWriteScope);
    if (conflicts.length > 0) {
      return { ...policyBase, allowed: false, reason: "write_conflict", conflicts };
    }

    return { ...policyBase, allowedTools: scopedWorkerAllowedTools(policyBase) };
  }

  private async writeConflicts(
    teamId: TeamId,
    task: TeamTaskRow,
    writeScope: string[] | undefined,
  ): Promise<TeamTaskDispatchConflict[]> {
    if (!writeScope || writeScope.length === 0) return [];
    const tasks = await this.options.teams.tasks(teamId);
    const conflicts: TeamTaskDispatchConflict[] = [];
    for (const candidate of tasks) {
      if (candidate.id === task.id || candidate.status !== "in_progress") continue;
      const candidateWriteScope = metadataStringArray(candidate.metadata, ["writeScope", "write_scope", "writeScopes", "write_scopes"]);
      if (!candidateWriteScope || !scopesOverlap(writeScope, candidateWriteScope)) continue;
      const conflict: TeamTaskDispatchConflict = {
        taskId: candidate.id,
        writeScope: candidateWriteScope,
      };
      if (candidate.ownerPath) conflict.ownerPath = candidate.ownerPath;
      conflicts.push(conflict);
    }
    return conflicts;
  }

  private now(): TimestampMs {
    return this.options.now ? this.options.now() : timestampNow();
  }
}

function teamTaskPrompt(
  task: TeamTaskRow,
  ownerPath: AgentPath,
  policy?: TeamTaskDispatchPolicyMetadata,
  worktreePath?: string,
): string {
  const verificationFeedback = failedVerificationFeedback(task.metadata);
  return [
    `Team task: ${task.teamId}/${task.id}`,
    `Assigned member path: ${ownerPath}`,
    `Title: ${task.title}`,
    task.description ? `Description:\n${task.description}` : undefined,
    worktreePath ? `Isolated worktree: ${worktreePath}` : undefined,
    worktreePath ? "Implement changes in this task worktree. Do not assume the main workspace has been modified." : undefined,
    verificationFeedback ? `Previous verifier feedback:\n${verificationFeedback}` : undefined,
    task.dependsOn.length > 0 ? `Dependencies: ${task.dependsOn.join(", ")}` : undefined,
    policy ? `Allowed tools: ${formatList(policy.allowedTools)}` : undefined,
    policy ? `Write scope: ${formatList(policy.writeScope)}` : undefined,
    policy ? `Execute scope: ${formatList(policy.executeScope)}` : undefined,
    "",
    "Work the task to completion. Use team tools for progress notes when helpful. When complete, call complete_task for your local subagent task with a concise summary.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function taskNeedsWorktree(task: TeamTaskRow): boolean {
  const writeScope = metadataStringArray(task.metadata, ["writeScope", "write_scope", "writeScopes", "write_scopes"]);
  if ((writeScope?.length ?? 0) > 0) return true;
  const requiredTools = normalizedToolNames(metadataStringArray(task.metadata, ["requiredTools", "required_tools", "toolScope", "tool_scope"]));
  return requiredTools.some((tool) => tool === "edit" || tool === "write" || tool === "apply_patch" || tool === "bash");
}

function failedVerificationFeedback(metadata: Record<string, unknown> | undefined): string | undefined {
  const verification = metadata?.verification;
  if (!isRecord(verification)) return undefined;
  if (verification.status !== "failed") return undefined;
  return typeof verification.feedback === "string" && verification.feedback.trim().length > 0
    ? verification.feedback.trim()
    : undefined;
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

function dispatchPolicyForMetadata(policy: TeamTaskDispatchPolicyMetadata): TeamTaskDispatchPolicyMetadata | undefined {
  if (!policy.allowed || policy.writeScope || policy.executeScope || policy.requiredTools || policy.conflicts || policy.allowedTools) return policy;
  return undefined;
}

function workerPolicyForDispatch(input: {
  teamId: TeamId;
  taskId: TaskId;
  memberPath: AgentPath;
  parentSessionId: SessionId;
  dispatchPolicy: TeamTaskDispatchPolicyMetadata;
}): WorkerToolPolicyTemplate {
  const policy: WorkerToolPolicyTemplate = {
    teamId: input.teamId,
    taskId: input.taskId,
    memberPath: input.memberPath,
    parentSessionId: input.parentSessionId,
    allowedTools: input.dispatchPolicy.allowedTools ?? scopedWorkerAllowedTools(input.dispatchPolicy),
    writeScope: input.dispatchPolicy.writeScope ?? [],
    executeScope: input.dispatchPolicy.executeScope ?? [],
  };
  return policy;
}

function scopedWorkerAllowedTools(policy: TeamTaskDispatchPolicyMetadata): string[] {
  const allowed = new Set<string>(SCOPED_WORKER_BASE_TOOLS);
  const requiredTools = normalizedToolNames(policy.requiredTools);
  const requiredWriteTools = requiredTools.filter((tool) => SCOPED_WORKER_WRITE_TOOLS.includes(tool as never));

  if ((policy.writeScope?.length ?? 0) > 0) {
    const writeTools = requiredWriteTools.length > 0 ? requiredWriteTools : [...SCOPED_WORKER_WRITE_TOOLS];
    for (const tool of writeTools) allowed.add(tool);
  }

  if ((policy.executeScope?.length ?? 0) > 0 || requiredTools.some((tool) => SCOPED_WORKER_EXECUTE_TOOLS.includes(tool as never))) {
    for (const tool of SCOPED_WORKER_EXECUTE_TOOLS) allowed.add(tool);
  }

  for (const tool of requiredTools) {
    if (!SCOPED_WORKER_WRITE_TOOLS.includes(tool as never) && !SCOPED_WORKER_EXECUTE_TOOLS.includes(tool as never)) {
      allowed.add(tool);
    }
  }

  if (!policy.memberToolScope || policy.memberToolScope.length === 0) return [...allowed].sort();

  const memberTools = new Set(normalizedToolNames(policy.memberToolScope));
  return [...allowed]
    .filter((tool) => isEssentialWorkerTool(tool) || memberTools.has("*") || memberTools.has(tool))
    .sort();
}

function normalizedToolNames(tools: readonly string[] | undefined): string[] {
  return (tools ?? []).map(normalizeToolName).filter(Boolean);
}

function normalizeToolName(tool: string): string {
  const normalized = tool.trim().toLowerCase();
  if (normalized === "shell" || normalized === "run_shell_command") return "bash";
  if (normalized === "read_file") return "read";
  if (normalized === "write_file") return "write";
  if (normalized === "patch") return "apply_patch";
  return normalized;
}

function isEssentialWorkerTool(tool: string): boolean {
  return (
    tool === "complete_task" ||
    tool === "tool_search" ||
    tool === "team_snapshot" ||
    tool === "team_task_list" ||
    tool === "team_task_update" ||
    tool === "team_message_send" ||
    tool === "team_message_list"
  );
}

function formatList(items: readonly string[] | undefined): string {
  return items && items.length > 0 ? items.join(", ") : "(none)";
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

function requiresExplicitScope(
  requiredTools: readonly string[],
  scopedTools: readonly string[],
  scope: readonly string[] | undefined,
): boolean {
  return requiredTools.some((tool) => scopedTools.includes(tool as never)) && (!scope || scope.length === 0);
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  const error = new Error("Team task dispatch aborted");
  error.name = "AbortError";
  throw error;
}

function isSignalAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  return isAbortError(error);
}

function isAbortError(error: unknown): boolean {
  const err = toError(error);
  return err.name === "AbortError" || err.message.toLowerCase().includes("aborted");
}
