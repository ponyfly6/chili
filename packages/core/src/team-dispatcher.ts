import type {
  AgentPath,
  AgentRunId,
  SessionId,
  TaskId,
  TeamId,
  TeamTaskStatus,
  TimestampMs,
  ToolCallId,
} from "@chili/protocol";
import {
  boundPersistedJsonValue,
  joinAgentPath,
  normalizePersistedError,
  timestampNow,
} from "@chili/protocol";
import type {
  AgentTaskCapabilityStore,
  AgentTaskFinalizationStore,
  AgentTaskRow,
  SubagentProjectionStore,
  TeamMemberRow,
  TeamTaskMutationResult,
  TeamTaskRow,
} from "@chili/store";
import type { LocalSubagentMode, LocalSubagentTaskInput, LocalSubagentTaskResult } from "./subagent.js";
import type { RuntimeSessionOperation, SessionOperationCoordinator } from "./runtime-service.js";
import { TeamTaskNotFoundError, type TeamControlService } from "./team.js";
import { isTeamTaskArtifactDelivered } from "./team-artifact.js";
import {
  resolveTeamSessionAuthority,
  TeamSessionAuthorityError,
  type TeamSessionAuthority,
  type TeamSessionResolver,
} from "./team-session-authority.js";
import {
  assertTeamTaskWorktreePath,
  preflightTeamTaskWorktree,
  type TeamWorktreeEnsureInput,
  type TeamWorktreeEnsureResult,
} from "./team-worktree.js";
import {
  completeWorkerToolPolicy,
  SCOPED_WORKER_BASE_TOOLS,
  SCOPED_WORKER_EXECUTE_TOOLS,
  SCOPED_WORKER_WRITE_TOOLS,
  type WorkerToolPolicyTemplate,
} from "./worker-policy.js";

const DISPATCH_METADATA_KEY = "chiliTeamDispatch";
const INCOMPLETE_AGENT_RESULT_ERROR =
  "subagent_incomplete: child result did not satisfy the completion contract; inspect the summary and retry or follow up";
const TEAM_DISPATCH_TEXT_JSON_BYTES = 64 * 1024;

export interface TeamTaskDispatchServiceOptions {
  teams: TeamControlService;
  subagents: TeamTaskSubagentRunner;
  store: SubagentProjectionStore;
  worktrees?: TeamTaskWorktreeManager;
  cwd: string;
  createId?: (prefix: string) => string;
  now?: () => TimestampMs;
  assertDelegationEnabled?: (input: { sessionId: SessionId; action: "team.dispatch" }) => Promise<void> | void;
  /** Resolve and authorize the persisted root session used for this dispatch. */
  resolveSession: TeamSessionResolver;
  /** Serialize team mutations with every other operation owned by the root session. */
  sessionOperations: SessionOperationCoordinator;
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
  cwd?: string;
  mode?: LocalSubagentMode;
  prompt?: string;
  sourceCallId?: ToolCallId;
  batchId?: string;
  batchIndex?: number;
  expectedBatchSize?: number;
  maxConcurrency?: number;
  signal?: AbortSignal;
}

export interface TeamTaskSyncInput {
  teamId: TeamId;
  taskId: TaskId;
  sessionId?: SessionId;
}

export interface TeamTaskReconcileInput {
  teamId?: TeamId;
  sessionId?: SessionId;
  limit?: number;
}

export interface TeamTaskAgentBinding {
  agentTaskId: TaskId;
  agentPath: AgentPath;
  runId: AgentRunId;
  generation: number;
  childSessionId: SessionId;
  mode: LocalSubagentMode;
  dispatchedAt: number;
  agentStatus: LocalSubagentTaskResult["status"] | AgentTaskRow["status"];
  syncedAt?: number;
  policy?: TeamTaskDispatchPolicyMetadata;
}

export interface TeamTaskDispatchIntent {
  state: "prepared" | "bound";
  dispatchId: string;
  agentTaskId: TaskId;
  agentPath: AgentPath;
  runId: AgentRunId;
  childSessionId: SessionId;
  ownerPath: AgentPath;
  mode: LocalSubagentMode;
  dispatchedAt: number;
  taskCwd: string;
  taskName: string;
  prompt: string;
  workerPolicy: WorkerToolPolicyTemplate;
  worktreeRequired?: boolean;
  policy?: TeamTaskDispatchPolicyMetadata;
  sourceCallId?: ToolCallId;
  batchId?: string;
  batchIndex?: number;
  expectedBatchSize?: number;
  maxConcurrency?: number;
}

type TeamTaskDispatchMetadataPatch = Partial<TeamTaskAgentBinding>
  & Partial<TeamTaskDispatchIntent>;

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

export type TeamTaskDispatchStatus = "running" | "completed" | "incomplete" | "failed" | "cancelled" | "skipped";
export type TeamTaskDispatchPolicyReason = "missing_member" | "member_unavailable" | "scope_mismatch" | "write_conflict";

export interface TeamTaskDispatchResult {
  status: TeamTaskDispatchStatus;
  teamTask: TeamTaskRow;
  agentTask?: LocalSubagentTaskResult;
  reason?: TeamTaskMutationResult["reason"] | "missing_owner" | "missing_session" | TeamTaskDispatchPolicyReason;
}

export class TeamTaskDispatchAuthorityError extends TeamSessionAuthorityError {
  constructor(message: string) {
    super(message);
    this.name = "TeamTaskDispatchAuthorityError";
  }
}

export interface TeamTaskSyncResult {
  applied: boolean;
  teamTask: TeamTaskRow;
  agentTask?: AgentTaskRow;
  reason?: "not_dispatched" | "agent_task_not_found" | "agent_running" | "team_already_final" | "team_not_in_progress" | "stale_dispatch";
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
    const authority = await this.resolveDispatchAuthority(input.teamId, input.sessionId, input.cwd);
    return this.options.sessionOperations.withSessionOperation(authority.sessionId, async (operation) => {
      const currentAuthority = await this.resolveDispatchAuthority(
        input.teamId,
        authority.sessionId,
        authority.cwd,
      );
      operation.assertCurrent();
      return this.dispatchTaskWithOperation(input, currentAuthority, operation);
    });
  }

  private async dispatchTaskWithOperation(
    input: TeamTaskDispatchInput,
    authority: TeamSessionAuthority,
    operation: RuntimeSessionOperation,
  ): Promise<TeamTaskDispatchResult> {
    const signal = combineAbortSignals(operation.signal, input.signal);
    operation.assertCurrent();
    throwIfAborted(signal);
    const task = await this.requireTeamTask(input.teamId, input.taskId);
    if (isFinalTeamTaskStatus(task.status)) {
      return { status: "skipped", reason: "already_resolved", teamTask: task };
    }
    if (task.dependsOn.length > 0) {
      const dependencies = new Map((await this.options.teams.tasks(task.teamId)).map((item) => [item.id, item]));
      if (task.dependsOn.some((id) => {
        const dependency = dependencies.get(id);
        return !dependency || !isTeamTaskArtifactDelivered(dependency);
      })) return { status: "skipped", reason: "blocked", teamTask: task };
    }

    const ownerPath = input.ownerPath ?? task.ownerPath;
    if (!ownerPath) return { status: "skipped", reason: "missing_owner", teamTask: task };

    const parentSessionId = authority.sessionId;
    const sessionCwd = authority.cwd;
    await preflightTeamTaskWorktree({
      cwd: sessionCwd,
      teamId: input.teamId,
      taskId: input.taskId,
      ...(task.metadata ? { metadata: task.metadata } : {}),
      requireExisting: false,
    });
    operation.assertCurrent();
    throwIfAborted(signal);
    await this.options.assertDelegationEnabled?.({
      sessionId: parentSessionId,
      action: "team.dispatch",
    });
    operation.assertCurrent();
    throwIfAborted(signal);

    const resumableIntent = dispatchIntent(task.metadata);
    if (task.status === "in_progress" && resumableIntent) {
      return this.resumeDispatchIntent({
        teamTask: task,
        intent: resumableIntent,
        authority,
        operation,
        signal,
      });
    }

    const dispatchPolicy = await this.dispatchPolicy({
      teamId: input.teamId,
      task,
      ownerPath,
    });
    if (!dispatchPolicy.allowed) {
      await this.revalidateDispatchAuthority(input.teamId, authority, operation);
      throwIfAborted(signal);
      const shouldBlockTask = dispatchPolicy.reason !== "member_unavailable";
      const updateInput: Parameters<TeamControlService["updateTask"]>[0] = {
        teamId: input.teamId,
        taskId: input.taskId,
        metadata: mergeDispatchMetadata(task.metadata, { policy: dispatchPolicy }),
        sessionId: parentSessionId,
      };
      if (shouldBlockTask) updateInput.status = "blocked";
      if (shouldBlockTask && dispatchPolicy.reason) updateInput.error = dispatchPolicy.reason;
      const blockedTask = await this.options.teams.updateTask(updateInput);
      return { status: "skipped", reason: dispatchPolicy.reason, teamTask: blockedTask };
    }

    const worktreeRequired = Boolean(this.options.worktrees && taskNeedsWorktree(task));
    const taskCwd = worktreeRequired
      ? await assertTeamTaskWorktreePath({ cwd: sessionCwd, teamId: input.teamId, taskId: input.taskId })
      : sessionCwd;
    operation.assertCurrent();
    throwIfAborted(signal);
    const mode = input.mode ?? "background";
    const intent = this.createDispatchIntent({
      input,
      task,
      ownerPath,
      parentSessionId,
      mode,
      taskCwd,
      prompt: input.prompt ?? teamTaskPrompt(task, ownerPath, dispatchPolicy, worktreeRequired ? taskCwd : undefined),
      workerPolicy: workerPolicyForDispatch({
        teamId: input.teamId,
        taskId: input.taskId,
        memberPath: ownerPath,
        parentSessionId,
        dispatchPolicy,
      }),
      worktreeRequired,
      ...(dispatchPolicyForMetadata(dispatchPolicy) ? { policy: dispatchPolicy } : {}),
    });

    await this.revalidateDispatchAuthority(input.teamId, authority, operation);
    throwIfAborted(signal);
    const claim = await this.options.teams.claimTask({
      teamId: input.teamId,
      taskId: input.taskId,
      ownerPath,
      claimedBy: ownerPath,
      metadata: replaceDispatchMetadata(task.metadata, intent),
      sessionId: parentSessionId,
    });
    if (!claim.applied) {
      return {
        status: "skipped",
        reason: claim.reason,
        teamTask: claim.task ?? task,
      };
    }

    const claimedTask = claim.task ?? (await this.requireTeamTask(input.teamId, input.taskId));
    let taskForDispatch = claimedTask;
    if (intent.worktreeRequired) {
      try {
        taskForDispatch = await this.ensureDispatchIntentWorktree(
          claimedTask,
          intent,
          authority,
          operation,
          signal,
        );
      } catch (error) {
        if (error instanceof TeamSessionAuthorityError) throw error;
        operation.assertCurrent();
        if (isSignalAbort(error, signal)) {
          await this.revalidateDispatchAuthority(input.teamId, authority, operation);
          await this.options.teams.updateTask({
            teamId: input.teamId,
            taskId: input.taskId,
            status: "pending",
            error: "",
            metadata: claimedTask.metadata ?? {},
            sessionId: parentSessionId,
          });
          throw error;
        }
        const err = toError(error);
        await this.revalidateDispatchAuthority(input.teamId, authority, operation);
        const blockedTask = await this.options.teams.updateTask({
          teamId: input.teamId,
          taskId: input.taskId,
          status: "blocked",
          error: `worktree_failed: ${err.message}`,
          metadata: mergeDispatchMetadata(claimedTask.metadata, intent),
          sessionId: parentSessionId,
        });
        return { status: "skipped", reason: "blocked", teamTask: blockedTask };
      }
    }
    try {
      await this.revalidateDispatchAuthority(input.teamId, authority, operation);
      throwIfAborted(signal);
      const spawnedAgentTask = await this.spawnDispatchIntent(intent, parentSessionId, signal, operation);
      operation.assertCurrent();
      throwIfAborted(signal);
      const projectedAgentTask = await this.options.store.agentTask(spawnedAgentTask.taskId);
      const agentTask = projectedAgentTask
        ? localTaskResultFromDispatchIntent(projectedAgentTask, intent, parentSessionId)
        : spawnedAgentTask;
      if (agentTask.status === "pending") {
        return { status: "running", teamTask: taskForDispatch, agentTask };
      }
      if (!projectedAgentTask) {
        throw new Error(`Spawned agent task is missing its durable projection: ${agentTask.taskId}`);
      }
      if (isFinalLocalSubagentStatus(agentTask.status)) {
        const synced = await this.syncTaskWithOperation({
          teamId: input.teamId,
          taskId: input.taskId,
          sessionId: parentSessionId,
        }, authority, operation);
        return {
          status: synced.applied ? agentTask.status : "running",
          teamTask: synced.teamTask,
          agentTask,
        };
      }
      const policyMetadata = dispatchPolicyForMetadata(dispatchPolicy);

      const updateInput = {
        task: taskForDispatch,
        agentTask,
        agentGeneration: projectedAgentTask.generation,
        mode,
        intent,
        sessionId: parentSessionId,
        ...(policyMetadata ? { policy: policyMetadata } : {}),
      };
      await this.revalidateDispatchAuthority(input.teamId, authority, operation);
      const teamTask = await this.updateTeamTaskFromAgentResult(updateInput);
      return {
        status: agentTask.status,
        teamTask,
        agentTask,
      };
    } catch (error) {
      if (error instanceof TeamSessionAuthorityError) throw error;
      operation.assertCurrent();
      const err = toError(error);
      await this.revalidateDispatchAuthority(input.teamId, authority, operation);
      let durableAgentTask = await this.options.store.agentTask(intent.agentTaskId);
      if (durableAgentTask) {
        let recovered = localTaskResultFromDispatchIntent(
          durableAgentTask,
          intent,
          parentSessionId,
        );
        if (isAbortError(err) && !isFinalAgentTaskStatus(durableAgentTask.status)) {
          durableAgentTask = await this.closeDispatchAfterAbort(durableAgentTask, authority, operation);
          recovered = localTaskResultFromDispatchIntent(
            durableAgentTask,
            intent,
            parentSessionId,
          );
        }
        if (isFinalAgentTaskStatus(durableAgentTask.status)) {
          const synced = await this.syncTaskWithOperation({
            teamId: input.teamId,
            taskId: input.taskId,
            sessionId: parentSessionId,
          }, authority, operation);
          return {
            status: synced.applied ? dispatchStatusFromAgentStatus(recovered.status) : "running",
            teamTask: synced.teamTask,
            agentTask: recovered,
          };
        }
        return {
          status: "running",
          teamTask: await this.requireTeamTask(input.teamId, input.taskId),
          agentTask: recovered,
        };
      }
      const teamTask = await this.options.teams.updateTask({
        teamId: input.teamId,
        taskId: input.taskId,
        status: isAbortError(err) ? "cancelled" : "failed",
        error: err.message,
        metadata: mergeDispatchMetadata(taskForDispatch.metadata, {
          ...intent,
          agentStatus: isAbortError(err) ? "cancelled" : "failed",
          syncedAt: Number(this.now()),
        }),
        sessionId: parentSessionId,
      });
      return { status: isAbortError(err) ? "cancelled" : "failed", teamTask };
    }
  }

  private createDispatchIntent(input: {
    input: TeamTaskDispatchInput;
    task: TeamTaskRow;
    ownerPath: AgentPath;
    parentSessionId: SessionId;
    mode: LocalSubagentMode;
    taskCwd: string;
    prompt: string;
    workerPolicy: WorkerToolPolicyTemplate;
    worktreeRequired: boolean;
    policy?: TeamTaskDispatchPolicyMetadata;
  }): TeamTaskDispatchIntent {
    const dispatchId = this.id("dispatch");
    const agentTaskId = this.id<TaskId>("task");
    const runId = this.id<AgentRunId>("agent");
    const childSessionId = this.id<SessionId>("session");
    const intent: TeamTaskDispatchIntent = {
      state: "prepared",
      dispatchId,
      agentTaskId,
      agentPath: joinAgentPath(input.ownerPath, agentTaskId),
      runId,
      childSessionId,
      ownerPath: input.ownerPath,
      mode: input.mode,
      dispatchedAt: Number(this.now()),
      taskCwd: boundedDispatchText(input.taskCwd, "team dispatch cwd"),
      taskName: boundedDispatchText(input.task.title, "team dispatch task name"),
      prompt: boundedDispatchText(input.prompt, "team dispatch prompt"),
      workerPolicy: input.workerPolicy,
    };
    if (input.worktreeRequired) intent.worktreeRequired = true;
    if (input.policy) intent.policy = input.policy;
    if (input.input.sourceCallId !== undefined) intent.sourceCallId = input.input.sourceCallId;
    if (input.input.batchId !== undefined) intent.batchId = input.input.batchId;
    if (input.input.batchIndex !== undefined) intent.batchIndex = input.input.batchIndex;
    if (input.input.expectedBatchSize !== undefined) intent.expectedBatchSize = input.input.expectedBatchSize;
    if (input.input.maxConcurrency !== undefined) intent.maxConcurrency = input.input.maxConcurrency;
    return intent;
  }

  private async spawnDispatchIntent(
    intent: TeamTaskDispatchIntent,
    parentSessionId: SessionId,
    signal: AbortSignal,
    operation: RuntimeSessionOperation,
  ): Promise<LocalSubagentTaskResult> {
    operation.assertCurrent();
    throwIfAborted(signal);
    const spawnInput: LocalSubagentTaskInput = {
      dispatchId: intent.dispatchId,
      taskId: intent.agentTaskId,
      runId: intent.runId,
      childSessionId: intent.childSessionId,
      parentSessionId,
      parentPath: intent.ownerPath,
      cwd: intent.taskCwd,
      taskName: intent.taskName,
      prompt: intent.prompt,
      mode: intent.mode,
      completionPolicy: "detached",
      workerPolicy: intent.workerPolicy,
      signal,
    };
    if (operation.runClaim) spawnInput.runClaim = operation.runClaim;
    if (intent.sourceCallId !== undefined) spawnInput.sourceCallId = intent.sourceCallId;
    if (intent.batchId !== undefined) spawnInput.batchId = intent.batchId;
    if (intent.batchIndex !== undefined) spawnInput.batchIndex = intent.batchIndex;
    if (intent.expectedBatchSize !== undefined) spawnInput.expectedBatchSize = intent.expectedBatchSize;
    if (intent.maxConcurrency !== undefined) spawnInput.maxConcurrency = intent.maxConcurrency;
    return this.options.subagents.spawnTask(spawnInput);
  }

  private async resumeDispatchIntent(input: {
    teamTask: TeamTaskRow;
    intent: TeamTaskDispatchIntent;
    authority: TeamSessionAuthority;
    operation: RuntimeSessionOperation;
    signal: AbortSignal;
  }): Promise<TeamTaskDispatchResult> {
    await this.revalidateDispatchAuthority(input.teamTask.teamId, input.authority, input.operation);
    throwIfAborted(input.signal);
    await this.assertDispatchIntentIdentity(input.teamTask, input.intent, input.authority);
    const durableTeamTask = input.intent.worktreeRequired
      ? await this.ensureDispatchIntentWorktree(
          input.teamTask,
          input.intent,
          input.authority,
          input.operation,
          input.signal,
        )
      : input.teamTask;
    const projected = await this.options.store.agentTask(input.intent.agentTaskId);
    const recovered = projected
      ? localTaskResultFromDispatchIntent(projected, input.intent, input.authority.sessionId)
      : undefined;
    if (!recovered || recovered.status === "pending") {
      await this.spawnDispatchIntent(
          input.intent,
          input.authority.sessionId,
          input.signal,
          input.operation,
        );
    }
    input.operation.assertCurrent();
    throwIfAborted(input.signal);
    let currentProjection = await this.options.store.agentTask(input.intent.agentTaskId);
    if (!currentProjection) {
      throw new Error(`Reserved agent task is missing after spawn: ${input.intent.agentTaskId}`);
    }
    let agentTask = localTaskResultFromDispatchIntent(
      currentProjection,
      input.intent,
      input.authority.sessionId,
    );
    if (agentTask.status === "pending") {
      return { status: "running", teamTask: durableTeamTask, agentTask };
    }
    if (agentTask.status === "running" && !hasActiveAgentTaskLease(currentProjection, Number(this.now()))) {
      currentProjection = await this.closeExpiredDispatchRun(
        currentProjection,
        input.authority,
        input.operation,
      );
      agentTask = localTaskResultFromDispatchIntent(
        currentProjection,
        input.intent,
        input.authority.sessionId,
      );
    }
    if (isFinalLocalSubagentStatus(agentTask.status)) {
      const synced = await this.syncTaskWithOperation({
        teamId: durableTeamTask.teamId,
        taskId: durableTeamTask.id,
        sessionId: input.authority.sessionId,
      }, input.authority, input.operation);
      return {
        status: synced.applied ? dispatchStatusFromAgentStatus(agentTask.status) : "running",
        teamTask: synced.teamTask,
        agentTask,
      };
    }
    await this.revalidateDispatchAuthority(durableTeamTask.teamId, input.authority, input.operation);
    const teamTask = await this.updateTeamTaskFromAgentResult({
      task: durableTeamTask,
      agentTask,
      agentGeneration: currentProjection.generation,
      mode: input.intent.mode,
      intent: input.intent,
      sessionId: input.authority.sessionId,
      ...(input.intent.policy ? { policy: input.intent.policy } : {}),
    });
    return {
      status: agentTask.status === "pending" ? "running" : agentTask.status,
      teamTask,
      agentTask,
    };
  }

  private async assertDispatchIntentIdentity(
    teamTask: TeamTaskRow,
    intent: TeamTaskDispatchIntent,
    authority: TeamSessionAuthority,
  ): Promise<void> {
    if (teamTask.ownerPath !== intent.ownerPath) {
      throw new Error(
        `Durable dispatch owner no longer matches task ${teamTask.teamId}/${teamTask.id}`,
      );
    }
    if (intent.agentPath !== joinAgentPath(intent.ownerPath, intent.agentTaskId)) {
      throw new Error(`Durable dispatch agent path is invalid: ${intent.dispatchId}`);
    }
    const workerPolicy = intent.workerPolicy;
    if (
      workerPolicy.teamId !== teamTask.teamId
      || workerPolicy.taskId !== teamTask.id
      || workerPolicy.memberPath !== intent.ownerPath
      || workerPolicy.parentSessionId !== authority.sessionId
    ) {
      throw new Error(`Durable dispatch worker policy identity is invalid: ${intent.dispatchId}`);
    }
    const expectedCwd = intent.worktreeRequired
      ? await assertTeamTaskWorktreePath({
          cwd: authority.cwd,
          teamId: teamTask.teamId,
          taskId: teamTask.id,
        })
      : authority.cwd;
    if (intent.taskCwd !== expectedCwd) {
      throw new Error(
        `Durable dispatch cwd is invalid: expected ${expectedCwd}, received ${intent.taskCwd}`,
      );
    }
  }

  private async closeExpiredDispatchRun(
    task: AgentTaskRow,
    authority: TeamSessionAuthority,
    operation: RuntimeSessionOperation,
  ): Promise<AgentTaskRow> {
    const store = this.agentTaskFinalizationStore();
    if (!store) return task;
    const closeInput: Parameters<AgentTaskFinalizationStore["closeAgentTaskCas"]>[0] = {
      taskId: task.id,
      status: "incomplete",
      eventId: this.id("event"),
      expectedGeneration: task.generation,
      expectedRunId: (task.currentRunId as AgentRunId | undefined) ?? null,
      expectedLeaseOwner: task.leaseOwner ?? null,
      requireExpiredLease: true,
      summary: "Worker lease expired before the team task could be synchronized",
      error: "team_dispatch_worker_lease_expired",
      sessionId: authority.sessionId,
      time: this.now(),
    };
    if (operation.runClaim) closeInput.runClaim = operation.runClaim;
    if (task.leaseExpiresAt !== undefined) closeInput.expectedLeaseExpiresAt = task.leaseExpiresAt;
    if (task.currentRunId) closeInput.agentEventId = this.id("event");
    const result = await store.closeAgentTaskCas(closeInput);
    return result.task ?? await this.requireAgentTask(task.id);
  }

  private async closeDispatchAfterAbort(
    task: AgentTaskRow,
    authority: TeamSessionAuthority,
    operation: RuntimeSessionOperation,
  ): Promise<AgentTaskRow> {
    const store = this.agentTaskFinalizationStore();
    if (!store) return task;
    if (task.status === "pending") {
      const closeInput: Parameters<AgentTaskFinalizationStore["closeAgentTaskCas"]>[0] = {
        taskId: task.id,
        status: "cancelled",
        eventId: this.id("event"),
        expectedGeneration: task.generation,
        expectedRunId: null,
        expectedLeaseOwner: null,
        summary: "Team dispatch was aborted before the reserved worker started",
        error: "team_dispatch_aborted_before_start",
        sessionId: authority.sessionId,
        time: this.now(),
      };
      if (operation.runClaim) closeInput.runClaim = operation.runClaim;
      const result = await store.closeAgentTaskCas(closeInput);
      return result.task ?? await this.requireAgentTask(task.id);
    }
    const closeInput: Parameters<AgentTaskFinalizationStore["closeAgentTaskCas"]>[0] = {
      taskId: task.id,
      status: "cancelled",
      eventId: this.id("event"),
      expectedGeneration: task.generation,
      expectedRunId: (task.currentRunId as AgentRunId | undefined) ?? null,
      expectedLeaseOwner: task.leaseOwner ?? null,
      summary: "Team dispatch was aborted while the reserved worker was starting",
      error: "team_dispatch_aborted_during_start",
      sessionId: authority.sessionId,
      time: this.now(),
    };
    if (task.currentRunId) closeInput.agentEventId = this.id("event");
    if (operation.runClaim) closeInput.runClaim = operation.runClaim;
    const result = await store.closeAgentTaskCas(closeInput);
    return result.task ?? await this.requireAgentTask(task.id);
  }

  private agentTaskFinalizationStore(): AgentTaskFinalizationStore | undefined {
    const store = this.options.store as SubagentProjectionStore
      & Partial<AgentTaskFinalizationStore>
      & Partial<AgentTaskCapabilityStore>;
    if (store.supportsAgentTaskCapability?.("finalization") === false) return undefined;
    return store.closeAgentTaskCas ? store as AgentTaskFinalizationStore : undefined;
  }

  private async requireAgentTask(taskId: TaskId): Promise<AgentTaskRow> {
    const task = await this.options.store.agentTask(taskId);
    if (!task) throw new Error(`Agent task not found: ${taskId}`);
    return task;
  }

  private async ensureDispatchIntentWorktree(
    teamTask: TeamTaskRow,
    intent: TeamTaskDispatchIntent,
    authority: TeamSessionAuthority,
    operation: RuntimeSessionOperation,
    signal: AbortSignal,
  ): Promise<TeamTaskRow> {
    if (!intent.worktreeRequired) return teamTask;
    await this.revalidateDispatchAuthority(teamTask.teamId, authority, operation);
    throwIfAborted(signal);
    const worktree = await this.ensureWorktree({
      teamId: teamTask.teamId,
      taskId: teamTask.id,
      cwd: authority.cwd,
      sessionId: authority.sessionId,
      signal,
    });
    operation.assertCurrent();
    throwIfAborted(signal);
    if (worktree.path !== intent.taskCwd) {
      throw new Error(
        `Task worktree path does not match durable dispatch ${intent.dispatchId}: expected ${intent.taskCwd}, received ${worktree.path}`,
      );
    }
    const persistedIntent = dispatchIntent(worktree.task.metadata);
    if (persistedIntent && canonicalJson(persistedIntent) === canonicalJson(intent)) return worktree.task;

    await this.revalidateDispatchAuthority(teamTask.teamId, authority, operation);
    return this.options.teams.updateTask({
      teamId: teamTask.teamId,
      taskId: teamTask.id,
      metadata: replaceDispatchMetadata(worktree.task.metadata, intent),
      sessionId: authority.sessionId,
    });
  }

  private async ensureWorktree(input: TeamWorktreeEnsureInput): Promise<TeamWorktreeEnsureResult> {
    if (!this.options.worktrees) {
      throw new Error("Team worktree service is not configured");
    }
    return this.options.worktrees.ensureTaskWorktree(input);
  }

  async syncTask(input: TeamTaskSyncInput): Promise<TeamTaskSyncResult> {
    const authority = await this.resolveDispatchAuthority(input.teamId, input.sessionId);
    return this.options.sessionOperations.withSessionOperation(authority.sessionId, async (operation) => {
      const currentAuthority = await this.resolveDispatchAuthority(
        input.teamId,
        authority.sessionId,
        authority.cwd,
      );
      operation.assertCurrent();
      return this.syncTaskWithOperation(input, currentAuthority, operation);
    });
  }

  private async syncTaskWithOperation(
    input: TeamTaskSyncInput,
    authority: TeamSessionAuthority,
    operation: RuntimeSessionOperation,
  ): Promise<TeamTaskSyncResult> {
    operation.assertCurrent();
    const teamTask = await this.requireTeamTask(input.teamId, input.taskId);
    const intent = dispatchIntent(teamTask.metadata);
    let binding = dispatchBinding(teamTask.metadata);
    if (!binding && !intent) return { applied: false, reason: "not_dispatched", teamTask };
    if (intent) await this.assertDispatchIntentIdentity(teamTask, intent, authority);

    const agentTaskId = binding?.agentTaskId ?? intent!.agentTaskId;
    let agentTask = await this.options.store.agentTask(agentTaskId);
    if (!agentTask) return { applied: false, reason: "agent_task_not_found", teamTask };
    if (intent) {
      localTaskResultFromDispatchIntent(agentTask, intent, authority.sessionId);
      if (
        (agentTask.currentRunId !== intent.runId
          && !(
            intent.state === "prepared"
            && agentTask.currentRunId === undefined
          ))
        || (binding && agentTask.generation < binding.generation)
      ) {
        return { applied: false, reason: "stale_dispatch", teamTask, agentTask };
      }
      binding = bindingFromDispatchIntent(intent, agentTask);
    } else if (
      agentTask.currentRunId !== binding!.runId
      || agentTask.generation !== binding!.generation
    ) {
      return { applied: false, reason: "stale_dispatch", teamTask, agentTask };
    }

    if (agentTask.status === "running" && !hasActiveAgentTaskLease(agentTask, Number(this.now()))) {
      agentTask = await this.closeExpiredDispatchRun(agentTask, authority, operation);
      if (intent) {
        localTaskResultFromDispatchIntent(agentTask, intent, authority.sessionId);
        binding = bindingFromDispatchIntent(intent, agentTask);
      }
    }
    if (!isFinalAgentTaskStatus(agentTask.status)) {
      return { applied: false, reason: "agent_running", teamTask, agentTask };
    }

    if (teamTask.status !== "in_progress") {
      return {
        applied: false,
        reason: isFinalTeamTaskStatus(teamTask.status) ? "team_already_final" : "team_not_in_progress",
        teamTask,
        agentTask,
      };
    }

    const status = teamStatusFromAgentStatus(agentTask.status) as Exclude<TeamTaskStatus, "pending" | "in_progress">;
    const error = agentTask.error
      ? agentTask.error
      : agentTask.status === "incomplete"
        ? INCOMPLETE_AGENT_RESULT_ERROR
        : status === "completed" && teamTask.error
          ? ""
          : undefined;
    await this.revalidateDispatchAuthority(input.teamId, authority, operation);
    const synced = await this.options.teams.syncTaskFromAgent({
      teamId: input.teamId,
      taskId: input.taskId,
      agentTaskId: binding!.agentTaskId,
      agentRunId: binding!.runId,
      agentGeneration: binding!.generation,
      agentStatus: agentTask.status,
      status,
      ...(agentTask.summary ? { summary: agentTask.summary } : {}),
      ...(error !== undefined ? { error } : {}),
      metadata: mergeDispatchMetadata(teamTask.metadata, {
        ...binding!,
        state: "bound",
        agentStatus: agentTask.status,
        syncedAt: Number(this.now()),
      }),
      sessionId: authority.sessionId,
    });
    const updated = synced.task ?? (await this.requireTeamTask(input.teamId, input.taskId));
    if (synced.applied) return { applied: true, teamTask: updated, agentTask };
    const reason = synced.reason === "agent_not_terminal"
      ? "agent_running"
      : synced.reason === "not_in_progress"
        ? isFinalTeamTaskStatus(updated.status) ? "team_already_final" : "team_not_in_progress"
        : "stale_dispatch";
    return { applied: false, reason, teamTask: updated, agentTask };
  }

  async reconcileTasks(input: TeamTaskReconcileInput = {}): Promise<TeamTaskReconcileResult> {
    const limit = input.limit ?? 500;
    const result: TeamTaskReconcileResult = {
      scanned: 0,
      synced: [],
      skipped: [],
      errors: [],
    };

    const teams = input.teamId
      ? [await this.requireTeam(input.teamId)]
      : (await this.options.teams.listTeams()).filter((team) => team.status === "active");
    for (const team of teams) {
      if (result.scanned >= limit) return result;
      const authority = await this.resolveDispatchAuthority(team.id, input.sessionId);
      await this.options.sessionOperations.withSessionOperation(authority.sessionId, async (operation) => {
        const currentAuthority = await this.resolveDispatchAuthority(
          team.id,
          authority.sessionId,
          authority.cwd,
        );
        operation.assertCurrent();
        const tasks = await this.options.teams.tasks(team.id);
        for (const task of tasks) {
          if (result.scanned >= limit) return;
          if (task.status !== "in_progress") continue;
          const binding = dispatchBinding(task.metadata);
          const intent = dispatchIntent(task.metadata);
          if (!binding && !intent) continue;

          result.scanned++;
          try {
            let synced: TeamTaskSyncResult;
            const projected = intent
              ? await this.options.store.agentTask(intent.agentTaskId)
              : undefined;
            if (intent && (!binding || !projected || projected.status === "pending")) {
              const recovered = await this.resumeDispatchIntent({
                teamTask: task,
                intent,
                authority: currentAuthority,
                operation,
                signal: operation.signal,
              });
              const agentTask = await this.options.store.agentTask(intent.agentTaskId);
              synced = {
                applied: true,
                teamTask: recovered.teamTask,
                ...(agentTask ? { agentTask } : {}),
              };
            } else {
              synced = await this.syncTaskWithOperation({
                teamId: team.id,
                taskId: task.id,
                sessionId: currentAuthority.sessionId,
              }, currentAuthority, operation);
            }
            if (synced.applied) result.synced.push(synced);
            else result.skipped.push(synced);
          } catch (error) {
            if (error instanceof TeamSessionAuthorityError) throw error;
            operation.assertCurrent();
            result.errors.push({
              teamId: team.id,
              taskId: task.id,
              error: toError(error).message,
            });
          }
        }
      });
    }
    return result;
  }

  private async updateTeamTaskFromAgentResult(input: {
    task: TeamTaskRow;
    agentTask: LocalSubagentTaskResult;
    agentGeneration: number;
    mode: LocalSubagentMode;
    intent: TeamTaskDispatchIntent;
    sessionId: SessionId;
    policy?: TeamTaskDispatchPolicyMetadata;
  }): Promise<TeamTaskRow> {
    if (isFinalLocalSubagentStatus(input.agentTask.status)) {
      throw new Error("Terminal agent results must be synchronized through the atomic team task CAS");
    }
    const update: Parameters<TeamControlService["updateTask"]>[0] = {
      teamId: input.task.teamId,
      taskId: input.task.id,
      status: "in_progress",
      metadata: mergeDispatchMetadata(input.task.metadata, {
        ...input.intent,
        state: "bound",
        agentTaskId: input.agentTask.taskId,
        agentPath: input.agentTask.path,
        runId: input.agentTask.runId,
        generation: input.agentGeneration,
        childSessionId: input.agentTask.childSessionId,
        mode: input.mode,
        dispatchedAt: input.intent.dispatchedAt,
        agentStatus: input.agentTask.status,
        ...(input.policy ? { policy: input.policy } : {}),
        ...(isFinalLocalSubagentStatus(input.agentTask.status) ? { syncedAt: Number(this.now()) } : {}),
      }),
      sessionId: input.sessionId,
    };
    return this.options.teams.updateTask(update);
  }

  private async requireTeam(teamId: TeamId) {
    const team = (await this.options.teams.listTeams()).find((item) => item.id === teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);
    return team;
  }

  private async resolveDispatchAuthority(
    teamId: TeamId,
    requestedSessionId?: SessionId,
    requestedCwd?: string,
  ): Promise<TeamSessionAuthority> {
    const team = await this.requireTeam(teamId);
    try {
      return await resolveTeamSessionAuthority({
        team,
        tasks: [],
        ...(requestedSessionId ? { requestedSessionId } : {}),
        ...(requestedCwd !== undefined ? { requestedCwd } : {}),
        resolveSession: this.options.resolveSession,
      });
    } catch (error) {
      if (error instanceof TeamTaskDispatchAuthorityError) throw error;
      const wrapped = new TeamTaskDispatchAuthorityError(toError(error).message);
      wrapped.cause = error;
      throw wrapped;
    }
  }

  private async revalidateDispatchAuthority(
    teamId: TeamId,
    authority: TeamSessionAuthority,
    operation: RuntimeSessionOperation,
  ): Promise<void> {
    await this.resolveDispatchAuthority(teamId, authority.sessionId, authority.cwd);
    operation.assertCurrent();
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

  private id<T extends string = string>(prefix: string): T {
    const create = this.options.createId ?? defaultCreateId;
    return create(prefix) as T;
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
  // New crash-safe dispatches persist their complete identity before spawn.
  // A generation left behind by an earlier binding must not turn that
  // prepared intent into a false binding during reconciliation. Legacy
  // bindings did not have a state field, so continue accepting those.
  if (value.state !== undefined && value.state !== "bound") return undefined;
  if (
    typeof value.agentTaskId !== "string" ||
    typeof value.agentPath !== "string" ||
    typeof value.runId !== "string" ||
    typeof value.generation !== "number" ||
    !Number.isInteger(value.generation) ||
    value.generation < 0 ||
    typeof value.childSessionId !== "string"
  ) {
    return undefined;
  }
  return value as unknown as TeamTaskAgentBinding;
}

function bindingFromDispatchIntent(
  intent: TeamTaskDispatchIntent,
  task: AgentTaskRow,
): TeamTaskAgentBinding {
  const binding: TeamTaskAgentBinding = {
    agentTaskId: intent.agentTaskId,
    agentPath: intent.agentPath,
    runId: intent.runId,
    generation: task.generation,
    childSessionId: intent.childSessionId,
    mode: intent.mode,
    dispatchedAt: intent.dispatchedAt,
    agentStatus: task.status,
  };
  if (intent.policy) binding.policy = intent.policy;
  return binding;
}

function dispatchIntent(metadata: Record<string, unknown> | undefined): TeamTaskDispatchIntent | undefined {
  const value = metadata?.[DISPATCH_METADATA_KEY];
  if (!isRecord(value)) return undefined;
  if (
    (value.state !== "prepared" && value.state !== "bound")
    || typeof value.dispatchId !== "string"
    || typeof value.agentTaskId !== "string"
    || typeof value.agentPath !== "string"
    || typeof value.runId !== "string"
    || typeof value.childSessionId !== "string"
    || typeof value.ownerPath !== "string"
    || !isLocalSubagentMode(value.mode)
    || typeof value.dispatchedAt !== "number"
    || typeof value.taskCwd !== "string"
    || typeof value.taskName !== "string"
    || typeof value.prompt !== "string"
    || !isRecord(value.workerPolicy)
    || (value.worktreeRequired !== undefined && typeof value.worktreeRequired !== "boolean")
  ) {
    return undefined;
  }
  return value as unknown as TeamTaskDispatchIntent;
}

function mergeDispatchMetadata(
  metadata: Record<string, unknown> | undefined,
  binding: TeamTaskDispatchMetadataPatch,
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

function replaceDispatchMetadata(
  metadata: Record<string, unknown> | undefined,
  intent: TeamTaskDispatchIntent,
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    [DISPATCH_METADATA_KEY]: intent,
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
  if (normalized === "agent_message_send") return "agent_send";
  if (normalized === "agent_message_list") return "agent_list";
  return normalized;
}

function isEssentialWorkerTool(tool: string): boolean {
  return (
    tool === "complete_task" ||
    tool === "agent_send" ||
    tool === "agent_list" ||
    tool === "code_mode" ||
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
  if (status === "incomplete") return "blocked";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return "in_progress";
}

function dispatchStatusFromAgentStatus(
  status: LocalSubagentTaskResult["status"] | AgentTaskRow["status"],
): TeamTaskDispatchStatus {
  return status === "pending" || status === "running" ? "running" : status;
}

function isFinalTeamTaskStatus(status: TeamTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isFinalAgentTaskStatus(
  status: AgentTaskRow["status"],
): status is Exclude<AgentTaskRow["status"], "pending" | "running"> {
  return status === "completed" || status === "incomplete" || status === "failed" || status === "cancelled";
}

function hasActiveAgentTaskLease(task: AgentTaskRow, now: number): boolean {
  return task.leaseExpiresAt !== undefined && task.leaseExpiresAt > now;
}

function isFinalLocalSubagentStatus(status: LocalSubagentTaskResult["status"]): boolean {
  return status === "completed" || status === "incomplete" || status === "failed" || status === "cancelled";
}

function localTaskResultFromDispatchIntent(
  task: AgentTaskRow,
  intent: TeamTaskDispatchIntent,
  parentSessionId: SessionId,
): LocalSubagentTaskResult {
  const workerPolicy = completeWorkerToolPolicy(intent.workerPolicy, intent.childSessionId);
  const exactIdentity = task.dispatchId === intent.dispatchId
    && task.reservedRunId === intent.runId
    && task.id === intent.agentTaskId
    && task.path === intent.agentPath
    && task.parentPath === intent.ownerPath
    && task.parentSessionId === parentSessionId
    && task.childSessionId === intent.childSessionId
    && task.taskName === intent.taskName
    && task.cwd === intent.taskCwd
    && task.prompt === intent.prompt
    && task.mode === intent.mode
    && task.completionPolicy === "detached"
    && task.sourceCallId === intent.sourceCallId
    && task.batchId === intent.batchId
    && task.batchIndex === intent.batchIndex
    && task.expectedBatchSize === intent.expectedBatchSize
    && task.maxConcurrency === intent.maxConcurrency
    && canonicalJson(task.workerPolicy) === canonicalJson(workerPolicy)
    && (!task.currentRunId || task.currentRunId === intent.runId);
  if (!exactIdentity) {
    throw new Error(`Agent task identity does not match durable dispatch ${intent.dispatchId}: ${intent.agentTaskId}`);
  }

  const result: LocalSubagentTaskResult = {
    taskId: task.id,
    runId: intent.runId,
    path: task.path,
    parentPath: intent.ownerPath,
    childSessionId: intent.childSessionId,
    status: task.status,
    workerPolicy,
  };
  if (task.sourceCallId !== undefined) result.sourceCallId = task.sourceCallId;
  if (task.batchId !== undefined) result.batchId = task.batchId;
  if (task.batchIndex !== undefined) result.batchIndex = task.batchIndex;
  if (task.expectedBatchSize !== undefined) result.expectedBatchSize = task.expectedBatchSize;
  if (task.maxConcurrency !== undefined) result.maxConcurrency = task.maxConcurrency;
  if (task.completionPolicy !== undefined) result.completionPolicy = task.completionPolicy;
  if (task.summary) result.summary = boundedDispatchText(task.summary, "team dispatch summary");
  if (task.error) result.error = normalizePersistedError(task.error);
  return result;
}

function isLocalSubagentMode(value: unknown): value is LocalSubagentMode {
  return value === "one_shot" || value === "resumable" || value === "background";
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalJsonValue(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalJsonValue(item)]),
  );
}

function defaultCreateId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
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
  return normalizePersistedError(error);
}

function boundedDispatchText(value: string, label: string): string {
  const bounded = boundPersistedJsonValue(value, {
    maxBytes: TEAM_DISPATCH_TEXT_JSON_BYTES,
    maxStringBytes: TEAM_DISPATCH_TEXT_JSON_BYTES - 2,
    maxItems: 1,
    maxDepth: 1,
    maxNodes: 1,
    label,
  });
  return typeof bounded === "string" ? bounded : "";
}

function combineAbortSignals(operationSignal: AbortSignal, inputSignal: AbortSignal | undefined): AbortSignal {
  if (!inputSignal || inputSignal === operationSignal) return operationSignal;
  return AbortSignal.any([operationSignal, inputSignal]);
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
