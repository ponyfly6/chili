import type {
  AgentPath,
  AgentRunId,
  AgentTaskMode,
  AgentTaskStatus,
  ChiliEvent,
  EventEnvelope,
  Message,
  SessionId,
  TaskId,
  ThreadId,
  TimestampMs,
} from "@chili/protocol";
import { ROOT_AGENT_PATH, timestampNow } from "@chili/protocol";
import type {
  AgentTaskCapabilityStore,
  AgentTaskFinalizationStore,
  AgentTaskLeaseStore,
  AgentMailboxDeliveryStore,
  AgentTaskQuery,
  AgentTaskRow,
  AgentTaskRunClaimStore,
  EventStore,
  SubagentProjectionStore,
} from "@chili/store";
import type { CompleteTaskToolInput, SubagentTaskCompletion, TaskWaitMode } from "@chili/tools";
import type { SubmitPromptInput, SubmitPromptResult } from "./runtime-service.js";
import {
  assessSubagentCompletion,
  type SubagentCompletionAssessment,
} from "./subagent-completion.js";
import type { LocalSubagentRunLimiter } from "./subagent-run-limiter.js";

export type AgentTaskFinalStatus = Exclude<AgentTaskStatus, "pending" | "running">;

const DEFAULT_AGENT_TASK_BATCH_WAIT_TIMEOUT_MS = 600_000;
const TASK_FOLLOWUP_LEASE_OWNER_PREFIX = "task-followup:";

export interface AgentTaskPromptRuntime {
  submitPrompt(input: SubmitPromptInput): Promise<SubmitPromptResult>;
}

export interface AgentTaskInterruptFence {
  runId: AgentRunId | null;
  generation: number;
}

export interface AgentTaskControlServiceOptions {
  store: EventStore
    & SubagentProjectionStore
    & Partial<AgentMailboxDeliveryStore>
    & Partial<AgentTaskFinalizationStore>
    & Partial<AgentTaskLeaseStore>
    & Partial<AgentTaskRunClaimStore>;
  runtime: AgentTaskPromptRuntime;
  interruptTask?: (taskId: TaskId, fence: AgentTaskInterruptFence) => boolean | Promise<boolean>;
  createId?: (prefix: string) => string;
  now?: () => TimestampMs;
  defaultWaitTimeoutMs?: number;
  pollIntervalMs?: number;
  leaseTtlMs?: number;
  leaseHeartbeatIntervalMs?: number;
  runLimiter?: LocalSubagentRunLimiter;
  assertDelegationEnabled?: (input: { sessionId: SessionId; action: "task.followup" }) => Promise<void> | void;
}

export interface AgentTaskFollowupInput {
  taskId: TaskId;
  text: string;
  maxTurns?: number;
  signal?: AbortSignal;
  /** Reuses an already-durable mailbox item; its caller owns consumption. */
  sourceMailboxMessageId?: string;
}

export interface AgentTaskFollowupResult {
  task: AgentTaskRow;
  result: SubmitPromptResult;
}

export interface AgentTaskWaitInput {
  taskId: TaskId;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface AgentTaskWaitBatchInput {
  taskIds: TaskId[];
  waitFor?: TaskWaitMode;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface AgentTaskWaitBatchResult {
  waitFor: TaskWaitMode;
  satisfied: boolean;
  timedOut: boolean;
  tasks: AgentTaskRow[];
}

export interface AgentTaskCloseInput {
  taskId: TaskId;
  status?: AgentTaskFinalStatus;
  summary?: string;
  error?: string;
  interrupt?: boolean;
}

export interface AgentTaskReconcileStaleInput {
  staleAfterMs?: number;
  modes?: AgentTaskMode[];
  liveTaskIds?: Iterable<TaskId | string>;
  limit?: number;
  summary?: string;
  error?: string;
}

export interface AgentTaskReconcileStaleResult {
  scanned: number;
  closed: AgentTaskRow[];
}

export class AgentTaskNotFoundError extends Error {
  constructor(readonly taskId: TaskId) {
    super(`Agent task not found: ${taskId}`);
    this.name = "AgentTaskNotFoundError";
  }
}

export class AgentTaskNotRunnableError extends Error {
  constructor(readonly taskId: TaskId, message = `Agent task cannot be resumed: ${taskId}`) {
    super(message);
    this.name = "AgentTaskNotRunnableError";
  }
}

export class AgentTaskWaitTimeoutError extends Error {
  constructor(readonly taskId: TaskId, readonly timeoutMs: number) {
    super(`Timed out waiting for agent task ${taskId} after ${timeoutMs}ms`);
    this.name = "AgentTaskWaitTimeoutError";
  }
}

interface ActiveTaskRun {
  task: AgentTaskRow;
  runId: AgentRunId;
  generation: number;
  controller: AbortController;
  completed: boolean;
  messageId: string;
  mailboxOwned: boolean;
  leaseLost?: boolean;
  ownershipLostBeforeSubmit?: boolean;
  delegationRejectedBeforeSubmit?: boolean;
  lease?: ActiveTaskRunLease;
}

interface ActiveTaskRunLease {
  owner: string;
  generation: number;
  ttlMs: number;
  expiresAt: number;
  timer?: ReturnType<typeof setInterval>;
  renewal?: Promise<void>;
  stopped?: boolean;
}

interface BegunTaskRun {
  task: AgentTaskRow;
  runId: AgentRunId;
  generation: number;
  messageId: string;
}

interface TaskFinalizationOutcome {
  applied: boolean;
  task: AgentTaskRow;
}

interface TaskCloseFenceOptions {
  requireExpiredLease?: boolean;
  expectedLeaseExpiresAt?: number | null;
  updatedBeforeOrAt?: number;
  mailboxMessageId?: string;
  mailboxDisposition?: "consume" | "requeue";
  mailboxError?: string;
}

export class AgentTaskControlService {
  private readonly activeRuns = new Map<string, ActiveTaskRun>();
  private readonly pendingRuns = new Map<string, AbortController>();

  constructor(private readonly options: AgentTaskControlServiceOptions) {}

  listTasks(query: AgentTaskQuery = {}): Promise<AgentTaskRow[]> {
    return this.options.store.agentTasks(query);
  }

  async getTask(taskId: TaskId): Promise<AgentTaskRow> {
    return this.requireTask(taskId);
  }

  async followupTask(input: AgentTaskFollowupInput): Promise<AgentTaskFollowupResult> {
    if (this.pendingRuns.has(input.taskId) || this.activeRuns.has(input.taskId)) {
      throw new AgentTaskNotRunnableError(input.taskId, `Agent task already has a pending or active turn: ${input.taskId}`);
    }

    const controller = linkedAbortController(input.signal);
    let releasePermit: (() => void) | undefined;
    this.pendingRuns.set(input.taskId, controller);
    try {
      if (controller.signal.aborted) throw abortError("Task follow-up aborted");
      const initialTask = await this.prepareRunnableTask(input);
      if (controller.signal.aborted) throw abortError("Task follow-up aborted");
      await this.assertFollowupDelegationEnabled(initialTask);
      if (controller.signal.aborted) throw abortError("Task follow-up aborted");
      releasePermit = await this.options.runLimiter?.acquire(controller.signal);
      if (controller.signal.aborted) throw abortError("Task follow-up aborted");
      await this.assertFollowupDelegationEnabled(initialTask);
      if (controller.signal.aborted) throw abortError("Task follow-up aborted");
      const begun = await this.beginTaskFollowup(
        initialTask,
        input.text,
        input.sourceMailboxMessageId,
      );
      const { task, runId, generation, messageId } = begun;
      const activeRun: ActiveTaskRun = {
        task,
        runId,
        generation,
        controller,
        completed: false,
        messageId,
        mailboxOwned: input.sourceMailboxMessageId !== undefined,
      };
      if (task.leaseOwner) {
        activeRun.lease = {
          owner: task.leaseOwner,
          generation,
          ttlMs: this.leaseTtlMs(),
          expiresAt: task.leaseExpiresAt ?? (Number(this.now()) + this.leaseTtlMs()),
        };
      }

      this.activeRuns.set(task.id, activeRun);
      try {
        if (controller.signal.aborted) throw abortError("Task follow-up aborted");
        try {
          await this.assertFollowupDelegationEnabled(task);
        } catch (error) {
          activeRun.delegationRejectedBeforeSubmit = true;
          throw error;
        }
        if (controller.signal.aborted) throw abortError("Task follow-up aborted");
        if (!await this.claimActiveFollowupRun(activeRun)) {
          if (!activeRun.leaseLost) activeRun.ownershipLostBeforeSubmit = true;
          throw new AgentTaskNotRunnableError(task.id, `Agent task follow-up lost ownership before provider start: ${task.id}`);
        }
        this.startFollowupLeaseHeartbeat(activeRun);
        if (controller.signal.aborted) throw abortError("Task follow-up aborted");
        const result = await this.options.runtime.submitPrompt(this.submitPromptInput(task, input, controller.signal));
        await this.quiesceFollowupLease(activeRun);
        if (activeRun.leaseLost) throw abortError("Task follow-up lease lost");
        if (await this.shouldCompleteRun(task.id, runId, activeRun)) {
          activeRun.completed = await this.completeFollowupRun(
            task,
            runId,
            generation,
            result,
            messageId,
            input.sourceMailboxMessageId !== undefined,
          );
        }

        return {
          task: await this.requireTask(input.taskId),
          result,
        };
      } catch (error) {
        await this.quiesceFollowupLease(activeRun);
        if (await this.shouldCompleteRun(task.id, runId, activeRun)) {
          const err = toError(error);
          const status: AgentTaskFinalStatus = activeRun.leaseLost
            ? "incomplete"
            : isAbortError(err)
            ? input.sourceMailboxMessageId ? "incomplete" : "cancelled"
            : "failed";
          const retryable = activeRun.leaseLost
            || activeRun.delegationRejectedBeforeSubmit
            || input.sourceMailboxMessageId !== undefined;
          if (retryable) {
            const outcome = await this.closeTaskFinal(
              task,
              status,
              undefined,
              err.message,
              {
                ...(activeRun.leaseLost && activeRun.lease
                  ? { expectedLeaseExpiresAt: activeRun.lease.expiresAt }
                  : {}),
                mailboxMessageId: messageId,
                mailboxDisposition: "requeue",
                mailboxError: err.message,
              },
            );
            activeRun.completed = outcome.applied;
          } else {
            activeRun.completed = await this.completeTaskFinal(
              task,
              status,
              runId,
              activeRun.generation,
              undefined,
              err.message,
              messageId,
            );
          }
        }
        if (!input.sourceMailboxMessageId && activeRun.ownershipLostBeforeSubmit) {
          await this.consumeTaskFollowup(task, messageId).catch(() => undefined);
        }
        throw error;
      } finally {
        this.stopFollowupLeaseHeartbeat(activeRun);
        this.activeRuns.delete(task.id);
      }
    } finally {
      if (this.pendingRuns.get(input.taskId) === controller) {
        this.pendingRuns.delete(input.taskId);
      }
      releasePermit?.();
    }
  }

  async completeTask(input: CompleteTaskToolInput): Promise<SubagentTaskCompletion> {
    const activeRun = this.activeRuns.get(input.taskId);
    if (!activeRun) {
      throw new AgentTaskNotRunnableError(input.taskId as TaskId, `No active follow-up run for task: ${input.taskId}`);
    }
    if (activeRun.completed) {
      throw new AgentTaskNotRunnableError(input.taskId as TaskId, `Active follow-up run already completed: ${input.taskId}`);
    }

    let status = input.status ?? "completed";
    let error: string | undefined;
    if (status === "completed") {
      const assessment = assessSubagentCompletion(input.summary);
      if (assessment.status === "incomplete") {
        status = "incomplete";
        error = completionAssessmentError(assessment);
      }
    }
    await this.quiesceFollowupLease(activeRun);
    const applied = await this.completeTaskFinal(
      activeRun.task,
      status,
      activeRun.runId,
      activeRun.generation,
      input.summary,
      error,
      activeRun.messageId,
    );
    if (!applied) {
      throw new AgentTaskNotRunnableError(input.taskId as TaskId, `Active follow-up run lost task ownership: ${input.taskId}`);
    }
    activeRun.completed = true;
    this.stopFollowupLeaseHeartbeat(activeRun);
    activeRun.controller.abort();
    return {
      taskId: input.taskId,
      summary: input.summary,
      status,
    };
  }

  async waitForTask(input: AgentTaskWaitInput): Promise<AgentTaskRow> {
    const timeoutMs = input.timeoutMs ?? this.options.defaultWaitTimeoutMs ?? 30_000;
    const deadline = Date.now() + timeoutMs;
    const pollIntervalMs = this.options.pollIntervalMs ?? 100;

    while (true) {
      if (input.signal?.aborted) throw abortError("Task wait aborted");
      const task = await this.requireTask(input.taskId);
      if (isFinalTaskStatus(task.status)) return task;

      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new AgentTaskWaitTimeoutError(input.taskId, timeoutMs);
      await delay(Math.min(pollIntervalMs, remaining), input.signal);
    }
  }

  async waitForTasks(input: AgentTaskWaitBatchInput): Promise<AgentTaskWaitBatchResult> {
    const taskIds = [...new Set(input.taskIds)];
    if (taskIds.length === 0) throw new Error("Agent task batch wait requires at least one task id");

    const waitFor = input.waitFor ?? "all";
    const timeoutMs = input.timeoutMs ?? this.options.defaultWaitTimeoutMs ?? DEFAULT_AGENT_TASK_BATCH_WAIT_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const pollIntervalMs = this.options.pollIntervalMs ?? 100;

    while (true) {
      if (input.signal?.aborted) throw abortError("Task batch wait aborted");
      const tasks = await Promise.all(taskIds.map((taskId) => this.requireTask(taskId)));
      const finalCount = tasks.filter((task) => isFinalTaskStatus(task.status)).length;
      const satisfied = waitFor === "any" ? finalCount > 0 : finalCount === tasks.length;
      if (satisfied) return { waitFor, satisfied: true, timedOut: false, tasks };

      const remaining = deadline - Date.now();
      if (remaining <= 0) return { waitFor, satisfied: false, timedOut: true, tasks };
      await delay(Math.min(pollIntervalMs, remaining), input.signal);
    }
  }

  async closeTask(input: AgentTaskCloseInput): Promise<AgentTaskRow> {
    // The durable task remains terminal while a follow-up waits for a permit.
    // Cancel this process's reservation before the terminal early return.
    // There is no durable terminal-task tombstone, so another process's queued
    // reservation is fenced only if some durable generation change wins first.
    this.pendingRuns.get(input.taskId)?.abort();
    const task = await this.requireTask(input.taskId);
    if (isFinalTaskStatus(task.status)) return task;

    const status = input.status ?? "cancelled";
    const activeRun = this.activeRuns.get(task.id);
    const outcome = await this.closeTaskFinal(
      task,
      status,
      input.summary,
      input.error,
      activeRun
        ? { mailboxMessageId: activeRun.messageId, mailboxDisposition: "consume" }
        : undefined,
    );
    if (!outcome.applied) return outcome.task;

    if (
      activeRun
      && activeRun.generation === task.generation
      && (!task.currentRunId || task.currentRunId === activeRun.runId)
    ) {
      activeRun.completed = true;
      this.stopFollowupLeaseHeartbeat(activeRun);
      activeRun.controller.abort();
    }
    if (input.interrupt !== false) {
      await this.options.interruptTask?.(task.id, {
        runId: (task.currentRunId as AgentRunId | undefined) ?? null,
        generation: task.generation,
      });
    }

    return outcome.task;
  }

  async reconcileStaleTasks(input: AgentTaskReconcileStaleInput = {}): Promise<AgentTaskReconcileStaleResult> {
    const limit = input.limit ?? 500;
    const staleAfterMs = input.staleAfterMs ?? 30_000;
    const cutoff = Number(this.now()) - staleAfterMs;
    const liveTaskIds = new Set([...(input.liveTaskIds ?? [])].map(String));
    const modes = input.modes ?? ["background"];
    const candidates = await this.options.store.agentTasks({ status: "running", limit });
    const closed: AgentTaskRow[] = [];

    for (const task of candidates) {
      if (liveTaskIds.has(task.id)) continue;
      if (modes.length > 0 && (!task.mode || !modes.includes(task.mode))) continue;
      if (task.leaseOwner && task.leaseExpiresAt && task.leaseExpiresAt > Number(this.now())) continue;
      if (task.updatedAt > cutoff) continue;
      const outcome = await this.closeTaskFinal(
        task,
        "cancelled",
        input.summary ?? "Marked stale: background worker is no longer running",
        input.error ?? "stale_background_worker",
        {
          requireExpiredLease: true,
          updatedBeforeOrAt: cutoff,
        },
      );
      if (outcome.applied) closed.push(outcome.task);
    }

    return {
      scanned: candidates.length,
      closed,
    };
  }

  private async requireTask(taskId: TaskId): Promise<AgentTaskRow> {
    const task = await this.options.store.agentTask(taskId);
    if (!task) throw new AgentTaskNotFoundError(taskId);
    return task;
  }

  private async requireRunnableTask(taskId: TaskId): Promise<AgentTaskRow> {
    const task = await this.requireTask(taskId);
    if (!task.childSessionId || !task.childThreadId) {
      throw new AgentTaskNotRunnableError(taskId, `Agent task is missing child session metadata: ${taskId}`);
    }
    if (!isFinalTaskStatus(task.status)) {
      throw new AgentTaskNotRunnableError(
        taskId,
        `Agent task initial turn has not reached a terminal state: ${taskId} (${task.status})`,
      );
    }
    return task;
  }

  private async prepareRunnableTask(input: AgentTaskFollowupInput): Promise<AgentTaskRow> {
    const observed = await this.requireTask(input.taskId);
    if (input.sourceMailboxMessageId && observed.status === "cancelled") {
      throw new AgentTaskNotRunnableError(
        input.taskId,
        `Cancelled agent task cannot be reopened by mailbox delivery: ${input.taskId}`,
      );
    }
    if (
      input.sourceMailboxMessageId
      && isRecoverableTaskFollowup(observed, Number(this.now()))
    ) {
      await this.closeTaskFinal(
        observed,
        "incomplete",
        "Recovered an interrupted task follow-up for durable mailbox retry",
        "interrupted_task_followup_recovered",
        {
          requireExpiredLease: true,
          expectedLeaseExpiresAt: observed.leaseExpiresAt!,
        },
      );
    }
    return this.requireRunnableTask(input.taskId);
  }

  private async assertFollowupDelegationEnabled(task: AgentTaskRow): Promise<void> {
    const sessionId = task.parentSessionId ?? task.childSessionId;
    if (!sessionId) return;
    await this.options.assertDelegationEnabled?.({
      sessionId,
      action: "task.followup",
    });
  }

  private submitPromptInput(task: AgentTaskRow, input: AgentTaskFollowupInput, signal: AbortSignal): SubmitPromptInput {
    if (!task.childSessionId || !task.childThreadId) {
      throw new AgentTaskNotRunnableError(task.id, `Agent task is missing child session metadata: ${task.id}`);
    }

    const promptInput: SubmitPromptInput = {
      sessionId: task.childSessionId,
      threadId: task.childThreadId,
      text: input.text,
    };
    if (task.cwd) promptInput.cwd = task.cwd;
    if (input.maxTurns !== undefined) promptInput.maxTurns = input.maxTurns;
    promptInput.signal = signal;
    return promptInput;
  }

  private async beginTaskFollowup(
    initialTask: AgentTaskRow,
    text: string,
    sourceMailboxMessageId?: string,
  ): Promise<BegunTaskRun> {
    const store = this.runClaimStore();
    if (store) {
      const runId = this.id<AgentRunId>("agent");
      const generation = initialTask.generation + 1;
      const messageId = sourceMailboxMessageId ?? this.id("event");
      const claimInput: Parameters<AgentTaskRunClaimStore["beginAgentTaskRunCas"]>[0] = {
        taskId: initialTask.id,
        expectedGeneration: initialTask.generation,
        expectedRunId: (initialTask.currentRunId as AgentRunId | undefined) ?? null,
        expectedLeaseOwner: initialTask.leaseOwner ?? null,
        runId,
        generation,
        leaseOwner: followupLeaseOwner(runId),
        leaseTtlMs: this.leaseTtlMs(),
        spawnEventId: this.id("event"),
        time: this.now(),
      };
      if (!sourceMailboxMessageId) {
        claimInput.messageEventId = messageId;
        claimInput.messageClaimEventId = this.id("event");
        claimInput.from = initialTask.parentPath ?? ROOT_AGENT_PATH;
        claimInput.message = { role: "user", content: text };
      } else {
        claimInput.sourceMailboxMessageId = sourceMailboxMessageId;
      }
      const sessionId = initialTask.parentSessionId ?? initialTask.childSessionId;
      if (sessionId) claimInput.sessionId = sessionId;
      if (initialTask.parentThreadId) claimInput.threadId = initialTask.parentThreadId;

      const result = await store.beginAgentTaskRunCas(claimInput);
      if (!result.applied) {
        const current = result.task;
        const detail = current
          ? `${current.status}, generation ${current.generation}`
          : "missing";
        throw new AgentTaskNotRunnableError(
          initialTask.id,
          `Agent task follow-up lost its generation claim: ${initialTask.id} (${detail})`,
        );
      }
      const task = result.task ?? await this.requireTask(initialTask.id);
      return { task, runId, generation, messageId };
    }

    // Compatibility for projection-only stores: retain the existing event
    // sequence, guarded by this service's in-process reservation map.
    const task = await this.requireRunnableTask(initialTask.id);
    const runId = this.id<AgentRunId>("agent");
    const generation = task.generation + 1;
    const messageId = await this.appendTaskFollowup(
      task,
      text,
      runId,
      generation,
      sourceMailboxMessageId,
    );
    return { task: await this.requireTask(initialTask.id), runId, generation, messageId };
  }

  private async appendTaskFollowup(
    task: AgentTaskRow,
    text: string,
    runId: AgentRunId,
    generation: number,
    sourceMailboxMessageId?: string,
  ): Promise<string> {
    const messageId = sourceMailboxMessageId ?? await this.append(task, "agent.message_queued", {
      taskId: task.id,
      path: task.path,
      from: task.parentPath ?? ROOT_AGENT_PATH,
      // This service executes the turn directly. Marking the audit message as
      // triggerTurn would let the mailbox pump execute the same prompt again.
      triggerTurn: false,
      childSessionId: task.childSessionId,
      childThreadId: task.childThreadId,
      message: { role: "user", content: text },
    });

    await this.append(task, "agent.spawned", {
      runId,
      taskId: task.id,
      path: task.path,
      parentPath: task.parentPath,
      parentSessionId: task.parentSessionId,
      parentThreadId: task.parentThreadId,
      childSessionId: task.childSessionId,
      childThreadId: task.childThreadId,
      taskName: task.taskName,
      cwd: task.cwd,
      mode: task.mode,
      generation,
    });
    return messageId;
  }

  private async consumeTaskFollowup(task: AgentTaskRow, messageId: string): Promise<void> {
    await this.append(task, "agent.message_consumed", {
      messageId,
      taskId: task.id,
      path: task.path,
      consumedBy: task.path,
    });
  }

  private async completeFollowupRun(
    task: AgentTaskRow,
    runId: AgentRunId,
    generation: number,
    result: SubmitPromptResult,
    messageId: string,
    mailboxOwned: boolean,
  ): Promise<boolean> {
    const status = mailboxOwned && result.status === "cancelled"
      ? "incomplete"
      : promptResultToTaskStatus(result);
    const summary = result.status === "completed"
      ? await this.assistantTextForPromptResult(task.childSessionId, result)
      : undefined;
    if (result.status === "completed") {
      const assessment = assessSubagentCompletion(summary);
      if (assessment.status === "incomplete") {
        // RuntimeService owns a normal interactive prompt, not a subagent repair loop.
        // Close this generation as incomplete so an explicit follow-up can retry it.
        return this.completeTaskFinal(
          task,
          "incomplete",
          runId,
          generation,
          assessment.summary,
          completionAssessmentError(assessment),
          messageId,
        );
      }
      return this.completeTaskFinal(task, "completed", runId, generation, assessment.summary, undefined, messageId);
    }
    if (mailboxOwned) {
      const outcome = await this.closeTaskFinal(
        task,
        status,
        undefined,
        result.error?.message ?? result.finishReason,
        {
          mailboxMessageId: messageId,
          mailboxDisposition: "requeue",
          ...((result.error?.message ?? result.finishReason)
            ? { mailboxError: result.error?.message ?? result.finishReason }
            : {}),
        },
      );
      return outcome.applied;
    }
    return this.completeTaskFinal(
      task,
      status,
      runId,
      generation,
      undefined,
      result.error?.message ?? result.finishReason,
      messageId,
    );
  }

  private async shouldCompleteRun(taskId: TaskId, runId: AgentRunId, activeRun: ActiveTaskRun): Promise<boolean> {
    if (activeRun.completed) return false;
    const current = await this.options.store.agentTask(taskId);
    if (!current) return false;
    if (current.currentRunId && current.currentRunId !== runId) return false;
    if (current.generation !== activeRun.generation) return false;
    return !isFinalTaskStatus(current.status);
  }

  private async claimActiveFollowupRun(activeRun: ActiveTaskRun): Promise<boolean> {
    const lease = activeRun.lease;
    const leaseStore = this.leaseStore();
    if (lease && leaseStore) {
      let result: Awaited<ReturnType<AgentTaskLeaseStore["renewAgentTaskLease"]>>;
      try {
        result = await leaseStore.renewAgentTaskLease({
          taskId: activeRun.task.id,
          owner: lease.owner,
          generation: lease.generation,
          ttlMs: lease.ttlMs,
          now: Number(this.now()),
        });
      } catch {
        activeRun.leaseLost = true;
        return false;
      }
      if (!result.acquired || !result.task) {
        const current = result.task ?? await this.options.store.agentTask(activeRun.task.id);
        if (
          current?.status === "running"
          && current.generation === activeRun.generation
          && current.currentRunId === activeRun.runId
          && current.leaseOwner === lease.owner
        ) activeRun.leaseLost = true;
        return false;
      }
      if (result.task.leaseExpiresAt !== undefined) lease.expiresAt = result.task.leaseExpiresAt;
      return result.task.status === "running"
        && result.task.generation === activeRun.generation
        && result.task.currentRunId === activeRun.runId
        && result.task.leaseOwner === lease.owner;
    }
    const current = await this.options.store.agentTask(activeRun.task.id);
    if (!current || current.status !== "running") return false;
    if (current.generation !== activeRun.generation || current.currentRunId !== activeRun.runId) return false;
    return true;
  }

  private async appendTaskCompletion(
    task: AgentTaskRow,
    status: AgentTaskFinalStatus,
    runId?: AgentRunId,
    generation?: number,
    summary?: string,
    error?: string,
  ): Promise<void> {
    await this.append(task, "agent.task_completed", {
      taskId: task.id,
      path: task.path,
      status,
      runId,
      generation,
      summary,
      error,
    });
  }

  private async completeTaskFinal(
    task: AgentTaskRow,
    status: AgentTaskFinalStatus,
    runId?: AgentRunId,
    generation?: number,
    summary?: string,
    error?: string,
    mailboxMessageId?: string,
  ): Promise<boolean> {
    const store = this.finalizationStore();
    if (store) {
      const input: Parameters<AgentTaskFinalizationStore["completeAgentTaskCas"]>[0] = {
        taskId: task.id,
        path: task.path,
        status,
        eventId: this.id("event"),
        expectedGeneration: generation ?? task.generation,
        expectedRunId: runId ?? (task.currentRunId as AgentRunId | undefined) ?? null,
        expectedLeaseOwner: task.leaseOwner ?? null,
      };
      if (runId) input.runId = runId;
      if (generation !== undefined) input.generation = generation;
      if (task.leaseOwner) input.requireActiveLease = true;
      if (summary) input.summary = summary;
      if (error) input.error = error;
      if (runId) input.agentEventId = this.id("event");
      if (mailboxMessageId) {
        input.mailboxMessageId = mailboxMessageId;
        input.mailboxConsumeEventId = this.id("event");
      }
      const sessionId = task.parentSessionId ?? task.childSessionId;
      if (sessionId) input.sessionId = sessionId;
      if (task.parentThreadId) input.threadId = task.parentThreadId;
      input.time = this.now();
      const result = await store.completeAgentTaskCas(input);
      return result.applied;
    }

    const events: ChiliEvent[] = [this.taskEvent(task, "agent.task_completed", {
      taskId: task.id,
      path: task.path,
      status,
      runId,
      generation,
      summary,
      error,
    }) as ChiliEvent];
    if (runId) {
      events.push(this.taskEvent(task, "agent.completed", {
        runId,
        taskId: task.id,
        path: task.path,
        status,
        generation,
        summary,
        error,
      }) as ChiliEvent);
    }
    if (mailboxMessageId) {
      events.push(this.taskEvent(task, "agent.message_consumed", {
        messageId: mailboxMessageId,
        taskId: task.id,
        path: task.path,
        consumedBy: task.path,
      }) as ChiliEvent);
    }
    await this.options.store.appendMany(events);
    return true;
  }

  private async closeTaskFinal(
    task: AgentTaskRow,
    status: AgentTaskFinalStatus,
    summary?: string,
    error?: string,
    fence: TaskCloseFenceOptions = {},
  ): Promise<TaskFinalizationOutcome> {
    const store = this.finalizationStore();
    if (store) {
      const input: Parameters<AgentTaskFinalizationStore["closeAgentTaskCas"]>[0] = {
        taskId: task.id,
        status,
        eventId: this.id("event"),
        expectedGeneration: task.generation,
        expectedRunId: (task.currentRunId as AgentRunId | undefined) ?? null,
        expectedLeaseOwner: task.leaseOwner ?? null,
      };
      if (summary) input.summary = summary;
      if (error) input.error = error;
      if (task.currentRunId) input.agentEventId = this.id("event");
      if (fence.requireExpiredLease) input.requireExpiredLease = true;
      if (fence.expectedLeaseExpiresAt !== undefined) {
        input.expectedLeaseExpiresAt = fence.expectedLeaseExpiresAt;
      }
      if (fence.updatedBeforeOrAt !== undefined) input.updatedBeforeOrAt = fence.updatedBeforeOrAt;
      if (fence.mailboxMessageId && fence.mailboxDisposition) {
        input.mailboxMessageId = fence.mailboxMessageId;
        input.mailboxEventId = this.id("event");
        input.mailboxDisposition = fence.mailboxDisposition;
        if (fence.mailboxError) input.mailboxError = fence.mailboxError;
      }
      const sessionId = task.parentSessionId ?? task.childSessionId;
      if (sessionId) input.sessionId = sessionId;
      if (task.parentThreadId) input.threadId = task.parentThreadId;
      input.time = this.now();
      const result = await store.closeAgentTaskCas(input);
      return {
        applied: result.applied,
        task: result.task ?? await this.requireTask(task.id),
      };
    }

    const current = await this.requireTask(task.id);
    if (
      isFinalTaskStatus(current.status)
      || current.generation !== task.generation
      || ((current.currentRunId as AgentRunId | undefined) ?? null)
        !== ((task.currentRunId as AgentRunId | undefined) ?? null)
      || (current.leaseOwner ?? null) !== (task.leaseOwner ?? null)
      || (fence.requireExpiredLease && current.leaseExpiresAt !== undefined && current.leaseExpiresAt > Number(this.now()))
      || (fence.updatedBeforeOrAt !== undefined && current.updatedAt > fence.updatedBeforeOrAt)
    ) {
      return { applied: false, task: current };
    }
    const closeGeneration = task.generation + 1;
    const currentRunId = current.currentRunId as AgentRunId | undefined;
    const events: ChiliEvent[] = [this.taskEvent(current, "agent.task_completed", {
      taskId: current.id,
      path: current.path,
      status,
      runId: currentRunId,
      generation: closeGeneration,
      summary,
      error,
    }) as ChiliEvent];
    if (currentRunId) {
      events.push(this.taskEvent(current, "agent.completed", {
        runId: currentRunId,
        taskId: current.id,
        path: current.path,
        status,
        generation: closeGeneration,
        summary,
        error,
      }) as ChiliEvent);
    }
    if (fence.mailboxMessageId && fence.mailboxDisposition) {
      events.push(this.taskEvent(
        current,
        fence.mailboxDisposition === "consume" ? "agent.message_consumed" : "agent.message_requeued",
        fence.mailboxDisposition === "consume"
          ? {
              messageId: fence.mailboxMessageId,
              taskId: current.id,
              path: current.path,
              consumedBy: current.path,
            }
          : {
              messageId: fence.mailboxMessageId,
              taskId: current.id,
              path: current.path,
              error: fence.mailboxError,
            },
      ) as ChiliEvent);
    }
    await this.options.store.appendMany(events);
    return { applied: true, task: await this.requireTask(task.id) };
  }

  private finalizationStore(): AgentTaskFinalizationStore | undefined {
    const store = this.options.store;
    const capabilityStore = store as EventStore & Partial<AgentTaskCapabilityStore>;
    if (capabilityStore.supportsAgentTaskCapability?.("finalization") === false) return undefined;
    if (store.completeAgentTaskCas && store.closeAgentTaskCas) {
      return store as EventStore & SubagentProjectionStore & AgentTaskFinalizationStore;
    }
    return undefined;
  }

  private runClaimStore(): AgentTaskRunClaimStore | undefined {
    const store = this.options.store;
    const capabilityStore = store as EventStore & Partial<AgentTaskCapabilityStore>;
    if (capabilityStore.supportsAgentTaskCapability?.("run-claim") === false) return undefined;
    if (store.beginAgentTaskRunCas) {
      return store as EventStore & SubagentProjectionStore & AgentTaskRunClaimStore;
    }
    return undefined;
  }

  private leaseStore(): AgentTaskLeaseStore | undefined {
    const store = this.options.store;
    const capabilityStore = store as EventStore & Partial<AgentTaskCapabilityStore>;
    if (capabilityStore.supportsAgentTaskCapability?.("lease") === false) return undefined;
    if (store.claimAgentTaskLease && store.renewAgentTaskLease && store.releaseAgentTaskLease) {
      return store as EventStore & SubagentProjectionStore & AgentTaskLeaseStore;
    }
    return undefined;
  }

  private leaseTtlMs(): number {
    return Math.max(1, this.options.leaseTtlMs ?? 30_000);
  }

  private leaseHeartbeatIntervalMs(ttlMs: number): number {
    return Math.max(1, this.options.leaseHeartbeatIntervalMs ?? Math.floor(ttlMs / 3));
  }

  private startFollowupLeaseHeartbeat(activeRun: ActiveTaskRun): void {
    const lease = activeRun.lease;
    if (!lease || lease.timer) return;
    lease.timer = setInterval(() => {
      void this.renewFollowupLease(activeRun);
    }, this.leaseHeartbeatIntervalMs(lease.ttlMs));
    unrefTimer(lease.timer);
  }

  private stopFollowupLeaseHeartbeat(activeRun: ActiveTaskRun): void {
    const lease = activeRun.lease;
    if (!lease || lease.stopped) return;
    lease.stopped = true;
    if (lease.timer) {
      clearInterval(lease.timer);
      delete lease.timer;
    }
  }

  private async quiesceFollowupLease(activeRun: ActiveTaskRun): Promise<void> {
    this.stopFollowupLeaseHeartbeat(activeRun);
    await activeRun.lease?.renewal;
  }

  private async renewFollowupLease(activeRun: ActiveTaskRun): Promise<void> {
    const lease = activeRun.lease;
    const store = this.leaseStore();
    if (!lease || lease.stopped || !store || activeRun.completed) return;
    if (lease.renewal) return lease.renewal;
    const renewal = (async () => {
      try {
        const result = await store.renewAgentTaskLease({
          taskId: activeRun.task.id,
          owner: lease.owner,
          generation: lease.generation,
          ttlMs: lease.ttlMs,
          now: Number(this.now()),
        });
        if (result.acquired) {
          if (result.task?.leaseExpiresAt !== undefined) lease.expiresAt = result.task.leaseExpiresAt;
          return;
        }
      } catch {
        // A renewal error is indistinguishable from lost ownership here. Abort
        // the provider turn and let the durable generation fence decide which
        // process may finalize or recover it.
      }
      const current = await this.options.store.agentTask(activeRun.task.id).catch(() => undefined);
      if (
        current
        && isFinalTaskStatus(current.status)
        && current.currentRunId === activeRun.runId
        && current.generation >= activeRun.generation
      ) {
        activeRun.completed = true;
        this.stopFollowupLeaseHeartbeat(activeRun);
        activeRun.controller.abort(abortError("Task follow-up was finalized externally"));
        return;
      }
      this.stopFollowupLeaseHeartbeat(activeRun);
      activeRun.leaseLost = true;
      activeRun.controller.abort(abortError("Task follow-up lease lost"));
    })();
    lease.renewal = renewal;
    try {
      await renewal;
    } finally {
      if (lease.renewal === renewal) delete lease.renewal;
    }
  }

  private async appendAgentCompletion(
    task: AgentTaskRow,
    status: AgentTaskFinalStatus,
    runId?: AgentRunId,
    generation?: number,
    summary?: string,
    error?: string,
  ): Promise<void> {
    if (!runId) return;
    await this.append(task, "agent.completed", {
      runId,
      taskId: task.id,
      path: task.path,
      status,
      generation,
      summary,
      error,
    });
  }

  private async assistantTextForPromptResult(
    sessionId: SessionId | undefined,
    result: Extract<SubmitPromptResult, { status: "completed" }>,
  ): Promise<string | undefined> {
    if (!sessionId) return undefined;
    const assistantMessageId = [...result.turns]
      .reverse()
      .find((turn) => turn.assistantMessageId)?.assistantMessageId;
    if (!assistantMessageId) return undefined;
    const messages = await this.options.store.messages(sessionId);
    const message = messages.find((candidate) => candidate.id === assistantMessageId && candidate.role === "assistant");
    return message ? textFromMessage(message) : undefined;
  }

  private async append<TType extends ChiliEvent["type"], TPayload>(
    task: AgentTaskRow,
    type: TType,
    payload: TPayload,
  ): Promise<string> {
    const event = this.taskEvent(task, type, payload);
    await this.options.store.append(event as ChiliEvent);
    return event.id;
  }

  private taskEvent<TType extends ChiliEvent["type"], TPayload>(
    task: AgentTaskRow,
    type: TType,
    payload: TPayload,
  ): EventEnvelope<TType, TPayload> {
    const event: EventEnvelope<TType, TPayload> = {
      id: this.id("event"),
      type,
      time: this.now(),
      payload: pruneUndefined(payload),
    };
    const sessionId = task.parentSessionId ?? task.childSessionId;
    if (sessionId) event.sessionId = sessionId;
    if (task.parentThreadId) event.threadId = task.parentThreadId;
    return event;
  }

  private id<T extends string>(prefix: string): T {
    const create = this.options.createId ?? defaultCreateId;
    return create(prefix) as T;
  }

  private now(): TimestampMs {
    return this.options.now ? this.options.now() : timestampNow();
  }
}

function promptResultToTaskStatus(result: SubmitPromptResult): AgentTaskFinalStatus {
  if (result.status === "completed") return "completed";
  if (result.status === "cancelled") return "cancelled";
  return "failed";
}

function completionAssessmentError(
  assessment: Extract<SubagentCompletionAssessment, { status: "incomplete" }>,
): string {
  return `Subagent completion incomplete: ${assessment.issue}`;
}

function isFinalTaskStatus(status: AgentTaskStatus): status is AgentTaskFinalStatus {
  return status === "completed" || status === "incomplete" || status === "failed" || status === "cancelled";
}

function followupLeaseOwner(runId: AgentRunId): string {
  return `${TASK_FOLLOWUP_LEASE_OWNER_PREFIX}${runId}`;
}

function isFollowupLeaseOwner(owner: string | undefined): boolean {
  return owner?.startsWith(TASK_FOLLOWUP_LEASE_OWNER_PREFIX) === true;
}

export function isRecoverableTaskFollowup(task: AgentTaskRow, now = Date.now()): boolean {
  return task.status === "running"
    && isFollowupLeaseOwner(task.leaseOwner)
    && task.leaseExpiresAt !== undefined
    && task.leaseExpiresAt <= now;
}

export function taskFollowupLeaseRetryAfterMs(task: AgentTaskRow, now = Date.now()): number | undefined {
  if (
    task.status !== "running"
    || !isFollowupLeaseOwner(task.leaseOwner)
    || task.leaseExpiresAt === undefined
    || task.leaseExpiresAt <= now
  ) return undefined;
  return Math.max(1, task.leaseExpiresAt - now);
}

function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  (timer as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.();
}

function textFromMessage(message: Message): string | undefined {
  const text = message.parts
    .filter((part): part is Extract<(typeof message.parts)[number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
  return text.length > 0 ? text : undefined;
}

function pruneUndefined<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) output[key] = item;
  }
  return output as T;
}

function defaultCreateId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError("Task wait aborted"));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(abortError("Task wait aborted"));
      },
      { once: true },
    );
  });
}

function linkedAbortController(signal: AbortSignal | undefined): AbortController {
  const controller = new AbortController();
  if (!signal) return controller;
  if (signal.aborted) {
    controller.abort();
    return controller;
  }
  signal.addEventListener("abort", () => controller.abort(), { once: true });
  return controller;
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isAbortError(error: Error): boolean {
  return error.name === "AbortError" || error.message.toLowerCase().includes("aborted");
}
