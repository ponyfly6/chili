import type {
  AgentPath,
  AgentRunId,
  ChiliEvent,
  EventEnvelope,
  SessionId,
  TaskId,
  TimestampMs,
  ToolCallId,
} from "@chili/protocol";
import { joinAgentPath, ROOT_AGENT_PATH, timestampNow } from "@chili/protocol";
import type {
  AgentTaskCapabilityStore,
  AgentTaskFinalizationStore,
  AgentTaskLeaseStore,
  AgentTaskRow,
  EventStore,
  SubagentProjectionStore,
} from "@chili/store";
import type {
  CompleteTaskToolInput,
  SubagentController,
  SubagentTaskCompletion,
  SubagentTaskHandle,
  SubagentToolContext,
  TaskCompletionPolicy,
  TaskToolInput,
} from "@chili/tools";
import {
  PromptAssembler,
  type PromptAssembly,
  type PromptFragment,
} from "./prompt/index.js";
import type { AgentRunner, RunTurnInput } from "./runner.js";
import type { RuntimePromptFragmentsProvider } from "./runtime-service.js";
import {
  assessSubagentCompletion,
  subagentCompletionRepairPrompt,
  type SubagentCompletionAssessment,
} from "./subagent-completion.js";
import {
  DEFAULT_LOCAL_SUBAGENT_MAX_ACTIVE_RUNS,
  LocalSubagentConcurrencyLimiter,
  type LocalSubagentRunLimiter,
} from "./subagent-run-limiter.js";
import {
  completeWorkerToolPolicy,
  workerPolicySystemSummary,
  type WorkerToolPolicy,
  type WorkerToolPolicyTemplate,
} from "./worker-policy.js";

const FINAL_RESPONSE_AFTER_MAX_TURNS_SYSTEM =
  "The automatic tool-use continuation limit has been reached. Do not call tools. Use the information already available in the conversation to give the best final answer now, and briefly state anything that remains uncertain.";

export {
  DEFAULT_LOCAL_SUBAGENT_MAX_ACTIVE_RUNS,
  LocalSubagentConcurrencyLimiter,
  type LocalSubagentRunLimiter,
  type LocalSubagentRunLimiterSnapshot,
} from "./subagent-run-limiter.js";

export type LocalSubagentMode = "one_shot" | "resumable" | "background";
export type LocalSubagentStatus = "pending" | "running" | "completed" | "incomplete" | "failed" | "cancelled";

export interface LocalSubagentSchedulingMetadata {
  sourceCallId?: ToolCallId;
  batchId?: string;
  batchIndex?: number;
  expectedBatchSize?: number;
  maxConcurrency?: number;
  completionPolicy?: TaskCompletionPolicy;
}

export interface LocalSubagentTaskInput extends LocalSubagentSchedulingMetadata {
  parentSessionId: SessionId;
  parentPath?: AgentPath;
  cwd: string;
  taskName: string;
  prompt: string;
  mode?: LocalSubagentMode;
  workerPolicy?: WorkerToolPolicyTemplate;
  signal?: AbortSignal;
}

export interface LocalSubagentRunInput extends LocalSubagentSchedulingMetadata {
  taskId: TaskId;
  runId: AgentRunId;
  path: AgentPath;
  parentPath: AgentPath;
  parentSessionId: SessionId;
  childSessionId: SessionId;
  cwd: string;
  taskName: string;
  prompt: string;
  mode?: LocalSubagentMode;
  generation: number;
  workerPolicy?: WorkerToolPolicy;
  signal?: AbortSignal;
}

export interface LocalSubagentRunResult {
  status: Exclude<LocalSubagentStatus, "pending" | "running">;
  summary?: string;
  error?: Error;
}

export interface LocalSubagentTaskResult extends LocalSubagentSchedulingMetadata {
  taskId: TaskId;
  runId: AgentRunId;
  path: AgentPath;
  parentPath: AgentPath;
  childSessionId: SessionId;
  status: LocalSubagentStatus;
  workerPolicy?: WorkerToolPolicy;
  summary?: string;
  error?: Error;
}

export interface LocalSubagentRunner {
  run(input: LocalSubagentRunInput): Promise<LocalSubagentRunResult>;
}

export type LocalSubagentBackgroundErrorHandler = (error: unknown, task: LocalSubagentTaskResult) => void;

export interface LocalSubagentManagerRunStats {
  maxActiveRuns?: number;
  activeRuns: number;
  queuedRuns: number;
  peakActiveRuns: number;
  backgroundTasks: number;
}

export interface LocalSubagentInterruptFence {
  runId: AgentRunId | null;
  generation: number;
}

export interface LocalSubagentManagerOptions {
  store: EventStore
    & Partial<AgentTaskLeaseStore>
    & Partial<AgentTaskFinalizationStore>
    & Partial<SubagentProjectionStore>;
  runner: LocalSubagentRunner;
  createId?: (prefix: string) => string;
  now?: () => TimestampMs;
  onBackgroundError?: LocalSubagentBackgroundErrorHandler;
  leaseTtlMs?: number;
  leaseHeartbeatIntervalMs?: number;
  maxActiveRuns?: number;
  runLimiter?: LocalSubagentRunLimiter;
  assertDelegationEnabled?: (input: { sessionId: SessionId; action: "task.spawn" }) => Promise<void> | void;
}

interface LocalSubagentTaskState {
  task: LocalSubagentTaskResult;
  runInput: LocalSubagentRunInput;
  controller: AbortController;
  lease?: LocalSubagentTaskLease;
  batchLimiter?: RetainedBatchLimiter;
  spawned?: boolean;
  externalFinalization?: Promise<void>;
  externallyClosed?: boolean;
  finalizationCommitted?: boolean;
  leaseLost?: boolean;
}

interface RetainedBatchLimiter {
  id: string;
  limiter: LocalSubagentConcurrencyLimiter;
}

interface BatchLimiterEntry extends RetainedBatchLimiter {
  references: number;
}

interface LocalSubagentTaskLease {
  owner: string;
  generation: number;
  expiresAt: number;
  ttlMs: number;
  heartbeatIntervalMs: number;
  timer?: ReturnType<typeof setInterval>;
  renewal?: Promise<Awaited<ReturnType<AgentTaskLeaseStore["renewAgentTaskLease"]>>>;
  stopped?: boolean;
}

export interface AgentRunnerSubagentRunnerOptions {
  runner: AgentRunner;
  store: EventStore;
  maxTurns?: number;
  promptFragments?: RuntimePromptFragmentsProvider;
}

export class LocalSubagentManager implements SubagentController {
  private readonly tasks = new Map<string, LocalSubagentTaskState>();
  private readonly backgroundTasks = new Set<Promise<void>>();
  private readonly batchLimiters = new Map<string, BatchLimiterEntry>();
  private readonly runLimiter: LocalSubagentRunLimiter;
  private activeRuns = 0;
  private queuedRuns = 0;
  private peakActiveRuns = 0;

  constructor(private readonly options: LocalSubagentManagerOptions) {
    this.runLimiter = options.runLimiter
      ?? new LocalSubagentConcurrencyLimiter(options.maxActiveRuns ?? DEFAULT_LOCAL_SUBAGENT_MAX_ACTIVE_RUNS);
  }

  async spawnTask(input: LocalSubagentTaskInput): Promise<LocalSubagentTaskResult>;
  async spawnTask(input: TaskToolInput, context: SubagentToolContext): Promise<SubagentTaskHandle>;
  async spawnTask(
    input: LocalSubagentTaskInput | TaskToolInput,
    context?: SubagentToolContext,
  ): Promise<LocalSubagentTaskResult | SubagentTaskHandle> {
    if (context) {
      const result = await this.spawnLocalTask(fromToolTaskInput(input as TaskToolInput, context));
      return {
        taskId: result.taskId,
        summary: result.summary ?? "",
        status: result.status,
      };
    }
    return this.spawnLocalTask(input as LocalSubagentTaskInput);
  }

  async completeTask(input: CompleteTaskToolInput): Promise<SubagentTaskCompletion> {
    const state = this.tasks.get(input.taskId);
    if (!state) {
      throw new Error(`No active local subagent task: ${input.taskId}`);
    }
    if (state.externallyClosed || state.task.status !== "running") {
      throw new Error(`Local subagent task already completed: ${input.taskId}`);
    }
    if (!(await this.ensureTaskLease(state))) {
      throw new Error(`Local subagent task lease lost: ${input.taskId}`);
    }
    let completionStatus = input.status ?? "completed";
    if (completionStatus === "completed") {
      const assessment = assessSubagentCompletion(input.summary);
      if (assessment.status === "incomplete") {
        completionStatus = "incomplete";
        state.task.error = completionIssueError(assessment);
      }
    }
    state.task.status = completionStatus;
    state.task.summary = input.summary;
    this.stopLeaseHeartbeat(state);
    if (!(await this.completeTaskFinal(state))) {
      state.externallyClosed = true;
      state.controller.abort();
      throw new Error(`Local subagent task finalization lost CAS: ${input.taskId}`);
    }
    state.controller.abort();
    return {
      taskId: input.taskId,
      summary: input.summary,
      status: completionStatus,
    };
  }

  async waitForBackgroundTasks(): Promise<void> {
    await Promise.allSettled([...this.backgroundTasks]);
  }

  runStats(): LocalSubagentManagerRunStats {
    const limiter = this.runLimiter.snapshot?.();
    return {
      ...(limiter ? { maxActiveRuns: limiter.maxActiveRuns } : {}),
      activeRuns: this.activeRuns,
      queuedRuns: this.queuedRuns,
      peakActiveRuns: this.peakActiveRuns,
      backgroundTasks: this.backgroundTasks.size,
    };
  }

  async interruptTask(taskId: TaskId | string, fence?: LocalSubagentInterruptFence): Promise<boolean> {
    const state = this.tasks.get(taskId);
    if (!state) return false;
    if (fence) {
      const currentRunId = state.spawned ? state.runInput.runId : null;
      const currentGeneration = state.spawned ? state.runInput.generation : 0;
      if (fence.runId !== currentRunId || fence.generation !== currentGeneration) return false;
    }
    if (isFinalLocalSubagentStatus(state.task.status)) return false;
    state.externallyClosed = true;
    state.task.status = "cancelled";
    this.stopLeaseHeartbeat(state);
    state.controller.abort();
    const finalization = this.beginExternalFinalization(state, "cancelled");
    await finalization;
    await this.releaseTaskLease(state);
    return true;
  }

  private async spawnLocalTask(input: LocalSubagentTaskInput): Promise<LocalSubagentTaskResult> {
    await this.options.assertDelegationEnabled?.({
      sessionId: input.parentSessionId,
      action: "task.spawn",
    });
    const taskId = this.id<TaskId>("task");
    const runId = this.id<AgentRunId>("agent");
    const parentPath = input.parentPath ?? ROOT_AGENT_PATH;
    const path = joinAgentPath(parentPath, taskId);
    const childSessionId = this.id<SessionId>("session");
    const mode = input.mode ?? "one_shot";
    const generation = 1;
    const controller = linkedAbortController(input.signal);
    const batchLimiter = this.retainBatchLimiter(input);
    const workerPolicy = input.workerPolicy
      ? completeWorkerToolPolicy(input.workerPolicy, childSessionId)
      : undefined;

    const task: LocalSubagentTaskResult = {
      taskId,
      runId,
      path,
      parentPath,
      childSessionId,
      status: "pending",
    };
    if (workerPolicy) task.workerPolicy = workerPolicy;
    assignSchedulingMetadata(task, input);

    try {
      await this.append(
        eventContext(input.parentSessionId),
        "agent.task_created",
        {
          taskId,
          path,
          parentPath,
          parentSessionId: input.parentSessionId,
          childSessionId,
          taskName: input.taskName,
          cwd: input.cwd,
          prompt: input.prompt,
          ...(mode ? { mode } : {}),
          ...(workerPolicy ? { workerPolicy } : {}),
          ...schedulingEventPayload(input),
        },
      );
    } catch (error) {
      this.releaseBatchLimiter(batchLimiter);
      throw error;
    }

    const runInput: LocalSubagentRunInput = {
      taskId,
      runId,
      path,
      parentPath,
      parentSessionId: input.parentSessionId,
      childSessionId,
      cwd: input.cwd,
      taskName: input.taskName,
      prompt: input.prompt,
      mode,
      generation,
    };
    if (workerPolicy) runInput.workerPolicy = workerPolicy;
    assignSchedulingMetadata(runInput, input);
    runInput.signal = controller.signal;

    const state: LocalSubagentTaskState = { task, runInput, controller };
    if (batchLimiter) state.batchLimiter = batchLimiter;
    this.tasks.set(taskId, state);

    if (mode === "background") {
      let promise: Promise<void>;
      promise = Promise.resolve().then(async () => {
        try {
          await this.completeFromRunner(state);
        } catch (error: unknown) {
          this.options.onBackgroundError?.(error, task);
        } finally {
          this.releaseBatchLimiter(state.batchLimiter);
          this.backgroundTasks.delete(promise);
        }
      });
      this.backgroundTasks.add(promise);
      return { ...task };
    }

    try {
      return await this.completeFromRunner(state);
    } finally {
      this.releaseBatchLimiter(state.batchLimiter);
    }
  }

  private async completeFromRunner(state: LocalSubagentTaskState): Promise<LocalSubagentTaskResult> {
    const { task, runInput: input } = state;
    const releases: Array<() => void> = [];
    let countedActive = false;
    try {
      this.queuedRuns++;
      try {
        if (state.batchLimiter) releases.push(await state.batchLimiter.limiter.acquire(input.signal));
        releases.push(await this.runLimiter.acquire(input.signal));
      } finally {
        this.queuedRuns = Math.max(0, this.queuedRuns - 1);
      }

      if (state.externallyClosed) {
        await state.externalFinalization;
        return task;
      }
      if (input.signal?.aborted) throw abortError();
      if (task.status !== "pending") {
        return task;
      }
      await this.options.assertDelegationEnabled?.({
        sessionId: input.parentSessionId,
        action: "task.spawn",
      });
      if (state.externallyClosed) {
        await state.externalFinalization;
        return task;
      }
      if (input.signal?.aborted) throw abortError();
      if (task.status !== "pending") return task;

      this.activeRuns++;
      countedActive = true;
      this.peakActiveRuns = Math.max(this.peakActiveRuns, this.activeRuns);
      task.status = "running";
      state.spawned = true;
      try {
        await this.appendAgentSpawned(state);
      } catch (error) {
        if (!state.externallyClosed) {
          task.status = "pending";
          state.spawned = false;
        }
        throw error;
      }
      const lease = await this.claimTaskLease(input);
      if (lease) {
        input.generation = lease.generation;
        state.lease = lease;
        this.startLeaseHeartbeat(state);
      }

      await this.options.assertDelegationEnabled?.({
        sessionId: input.parentSessionId,
        action: "task.spawn",
      });
      if (state.externallyClosed) {
        await state.externalFinalization;
        return task;
      }
      if (input.signal?.aborted) throw abortError();
      if (task.status !== "running") return task;
      if (!(await this.ensureTaskLease(state))) {
        await state.externalFinalization;
        return task;
      }

      const result = await this.options.runner.run(input);
      if (state.externallyClosed) {
        await state.externalFinalization;
        return task;
      }
      if (input.signal?.aborted) throw abortError();
      if (task.status !== "running") {
        this.stopLeaseHeartbeat(state);
        return task;
      }
      if (!(await this.ensureTaskLease(state))) {
        await state.externalFinalization;
        return task;
      }
      task.status = result.status;
      if (result.summary) task.summary = result.summary;
      if (result.error) task.error = result.error;
      this.stopLeaseHeartbeat(state);
      if (!(await this.completeTaskFinal(state))) state.externallyClosed = true;
      return task;
    } catch (error) {
      if (state.externallyClosed) {
        await state.externalFinalization;
        return task;
      }
      if (task.status !== "running") {
        if (isFinalLocalSubagentStatus(task.status)) {
          this.stopLeaseHeartbeat(state);
          return task;
        }
        const err = toError(error);
        await this.beginExternalFinalization(
          state,
          isAbortError(err) ? "cancelled" : "failed",
          err,
        );
        return task;
      }
      if (!(await this.ensureTaskLease(state))) {
        await state.externalFinalization;
        return task;
      }
      const err = toError(error);
      task.status = isAbortError(err) ? "cancelled" : "failed";
      task.error = err;
      this.stopLeaseHeartbeat(state);
      if (!(await this.completeTaskFinal(state))) state.externallyClosed = true;
      return task;
    } finally {
      this.stopLeaseHeartbeat(state);
      if (countedActive) this.activeRuns = Math.max(0, this.activeRuns - 1);
      for (let index = releases.length - 1; index >= 0; index--) releases[index]?.();
    }
  }

  private async appendAgentSpawned(state: LocalSubagentTaskState): Promise<void> {
    const input = state.runInput;
    await this.append(
      eventContext(input.parentSessionId),
      "agent.spawned",
      {
        runId: input.runId,
        path: input.path,
        parentPath: input.parentPath,
        taskId: input.taskId,
        parentSessionId: input.parentSessionId,
        childSessionId: input.childSessionId,
        taskName: input.taskName,
        cwd: input.cwd,
        generation: input.generation,
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.workerPolicy ? { workerPolicy: input.workerPolicy } : {}),
        ...schedulingEventPayload(input),
      },
    );
  }

  private retainBatchLimiter(input: LocalSubagentTaskInput): RetainedBatchLimiter | undefined {
    validateSchedulingMetadata(input);
    if (input.maxConcurrency === undefined || !input.batchId) return undefined;

    const existing = this.batchLimiters.get(input.batchId);
    if (existing) {
      if (existing.limiter.maxActiveRuns !== input.maxConcurrency) {
        throw new Error(
          `Batch ${input.batchId} already uses maxConcurrency=${existing.limiter.maxActiveRuns}; received ${input.maxConcurrency}`,
        );
      }
      existing.references++;
      return existing;
    }

    const entry: BatchLimiterEntry = {
      id: input.batchId,
      limiter: new LocalSubagentConcurrencyLimiter(input.maxConcurrency),
      references: 1,
    };
    this.batchLimiters.set(input.batchId, entry);
    return entry;
  }

  private releaseBatchLimiter(retained: RetainedBatchLimiter | undefined): void {
    if (!retained) return;
    const entry = this.batchLimiters.get(retained.id);
    if (!entry || entry.limiter !== retained.limiter) return;
    entry.references = Math.max(0, entry.references - 1);
    if (entry.references === 0) this.batchLimiters.delete(entry.id);
  }

  private beginExternalFinalization(
    state: LocalSubagentTaskState,
    status: Exclude<LocalSubagentStatus, "pending" | "running">,
    error?: Error,
  ): Promise<void> {
    if (state.externalFinalization) return state.externalFinalization;
    state.externallyClosed = true;
    state.task.status = status;
    if (error) state.task.error = error;
    this.stopLeaseHeartbeat(state);
    state.externalFinalization = this.finalizeExternalClosure(state);
    return state.externalFinalization;
  }

  private async finalizeExternalClosure(state: LocalSubagentTaskState): Promise<void> {
    const { task, runInput: input } = state;
    if (!isFinalLocalSubagentStatus(task.status)) return;
    const store = this.finalizationStore();
    if (store) {
      const closeInput: Parameters<AgentTaskFinalizationStore["closeAgentTaskCas"]>[0] = {
        taskId: input.taskId,
        status: task.status,
        eventId: this.id("event"),
        expectedGeneration: state.spawned ? input.generation : 0,
        expectedRunId: state.spawned ? input.runId : null,
        expectedLeaseOwner: state.lease?.owner ?? null,
        sessionId: input.parentSessionId,
        time: this.now(),
      };
      if (state.lease) {
        if (state.leaseLost) closeInput.expectedLeaseExpiresAt = state.lease.expiresAt;
        else closeInput.requireActiveLease = true;
      }
      if (task.summary) closeInput.summary = task.summary;
      if (task.error) closeInput.error = task.error.message;
      if (state.spawned) closeInput.agentEventId = this.id("event");
      const result = await store.closeAgentTaskCas(closeInput);
      if (result.applied) state.finalizationCommitted = true;
      if (result.task) this.hydrateAuthoritativeTask(state, result.task);
      return;
    }

    await this.appendCompletionEvents(input, task, state.spawned === true);
    state.finalizationCommitted = true;
  }

  private async claimTaskLease(input: LocalSubagentRunInput): Promise<LocalSubagentTaskLease | undefined> {
    const store = this.leaseStore();
    if (!store) return undefined;

    const ttlMs = this.options.leaseTtlMs ?? 30_000;
    const result = await store.claimAgentTaskLease({
      taskId: input.taskId,
      runId: input.runId,
      generation: input.generation,
      owner: leaseOwner(input.runId),
      ttlMs,
      now: Number(this.now()),
    });
    if (!result.acquired || !result.task) {
      throw new Error(`Could not acquire local subagent task lease: ${input.taskId}`);
    }

    return {
      owner: leaseOwner(input.runId),
      generation: result.task.generation,
      expiresAt: result.task.leaseExpiresAt ?? (Number(this.now()) + ttlMs),
      ttlMs,
      heartbeatIntervalMs: this.leaseHeartbeatIntervalMs(ttlMs),
    };
  }

  private startLeaseHeartbeat(state: LocalSubagentTaskState): void {
    const lease = state.lease;
    if (!lease || lease.timer) return;
    lease.timer = setInterval(() => {
      void this.renewTaskLease(state).catch((error) => this.cancelForLeaseLoss(state, error));
    }, lease.heartbeatIntervalMs);
    unrefTimer(lease.timer);
  }

  private stopLeaseHeartbeat(state: LocalSubagentTaskState): void {
    const lease = state.lease;
    if (!lease || lease.stopped) return;
    lease.stopped = true;
    if (lease.timer) {
      clearInterval(lease.timer);
      delete lease.timer;
    }
  }

  private async renewTaskLease(state: LocalSubagentTaskState): Promise<void> {
    const lease = state.lease;
    const store = this.leaseStore();
    if (!lease || lease.stopped || !store) return;

    const result = await this.renewTaskLeaseOnce(state, store, lease);
    if (result.acquired) {
      if (result.task?.leaseExpiresAt !== undefined) lease.expiresAt = result.task.leaseExpiresAt;
      return;
    }
    this.cancelForLeaseLoss(state);
  }

  private async ensureTaskLease(state: LocalSubagentTaskState): Promise<boolean> {
    const lease = state.lease;
    const store = this.leaseStore();
    if (!lease || !store) return true;
    if (lease.stopped) return true;

    let result: Awaited<ReturnType<AgentTaskLeaseStore["renewAgentTaskLease"]>>;
    try {
      result = await this.renewTaskLeaseOnce(state, store, lease);
    } catch (error) {
      this.cancelForLeaseLoss(state, error);
      return false;
    }
    if (result.acquired) {
      if (result.task?.leaseExpiresAt !== undefined) lease.expiresAt = result.task.leaseExpiresAt;
      return true;
    }
    this.cancelForLeaseLoss(state);
    return false;
  }

  private async renewTaskLeaseOnce(
    state: LocalSubagentTaskState,
    store: AgentTaskLeaseStore,
    lease: LocalSubagentTaskLease,
  ): Promise<Awaited<ReturnType<AgentTaskLeaseStore["renewAgentTaskLease"]>>> {
    if (lease.renewal) return lease.renewal;
    const renewal = store.renewAgentTaskLease({
      taskId: state.runInput.taskId,
      owner: lease.owner,
      generation: lease.generation,
      ttlMs: lease.ttlMs,
      now: Number(this.now()),
    });
    lease.renewal = renewal;
    try {
      return await renewal;
    } finally {
      if (lease.renewal === renewal) delete lease.renewal;
    }
  }

  private cancelForLeaseLoss(state: LocalSubagentTaskState, error?: unknown): void {
    if (state.externallyClosed || isFinalLocalSubagentStatus(state.task.status)) return;
    const leaseError = error === undefined
      ? new Error(`Local subagent task lease lost: ${state.task.taskId}`)
      : toError(error);
    state.leaseLost = true;
    state.controller.abort();
    const finalization = this.beginExternalFinalization(state, "cancelled", leaseError);
    void finalization.catch((finalizationError) => {
      this.options.onBackgroundError?.(finalizationError, state.task);
    });
    if (error) this.options.onBackgroundError?.(error, state.task);
  }

  private async releaseTaskLease(state: LocalSubagentTaskState): Promise<void> {
    const lease = state.lease;
    const store = this.leaseStore();
    if (!lease || !store) return;
    await store.releaseAgentTaskLease({
      taskId: state.runInput.taskId,
      owner: lease.owner,
      generation: lease.generation,
      now: Number(this.now()),
    });
  }

  private async completeTaskFinal(state: LocalSubagentTaskState): Promise<boolean> {
    const { task, runInput: input } = state;
    if (!isFinalLocalSubagentStatus(task.status)) return false;

    const store = this.finalizationStore();
    if (store) {
      const casInput: Parameters<AgentTaskFinalizationStore["completeAgentTaskCas"]>[0] = {
        taskId: input.taskId,
        path: input.path,
        runId: input.runId,
        status: task.status,
        expectedGeneration: input.generation,
        expectedRunId: input.runId,
        expectedLeaseOwner: state.lease?.owner ?? null,
        generation: input.generation,
        eventId: this.id("event"),
        sessionId: input.parentSessionId,
        time: this.now(),
      };
      if (state.lease) casInput.requireActiveLease = true;
      if (task.summary) casInput.summary = task.summary;
      if (task.error) casInput.error = task.error.message;
      if (state.spawned) casInput.agentEventId = this.id("event");
      const result = await store.completeAgentTaskCas(casInput);
      if (result.applied) state.finalizationCommitted = true;
      if (result.task) this.hydrateAuthoritativeTask(state, result.task);
      return result.applied;
    }

    await this.appendCompletionEvents(input, task, state.spawned === true);
    state.finalizationCommitted = true;
    return true;
  }

  private leaseStore(): AgentTaskLeaseStore | undefined {
    const store = this.options.store;
    const capabilityStore = store as EventStore & Partial<AgentTaskCapabilityStore>;
    if (capabilityStore.supportsAgentTaskCapability?.("lease") === false) return undefined;
    if (store.claimAgentTaskLease && store.renewAgentTaskLease && store.releaseAgentTaskLease) {
      return store as EventStore & AgentTaskLeaseStore;
    }
    return undefined;
  }

  private finalizationStore(): AgentTaskFinalizationStore | undefined {
    const store = this.options.store;
    const capabilityStore = store as EventStore & Partial<AgentTaskCapabilityStore>;
    if (capabilityStore.supportsAgentTaskCapability?.("finalization") === false) return undefined;
    if (store.completeAgentTaskCas && store.closeAgentTaskCas) {
      return store as EventStore & AgentTaskFinalizationStore;
    }
    return undefined;
  }

  private leaseHeartbeatIntervalMs(ttlMs: number): number {
    const configured = this.options.leaseHeartbeatIntervalMs;
    if (configured !== undefined) return Math.max(1, configured);
    return Math.max(1, Math.floor(ttlMs / 3));
  }

  private hydrateAuthoritativeTask(state: LocalSubagentTaskState, authoritative: AgentTaskRow): void {
    state.task.status = authoritative.status;
    if (authoritative.summary !== undefined) state.task.summary = authoritative.summary;
    else delete state.task.summary;
    if (authoritative.error !== undefined) state.task.error = new Error(authoritative.error);
    else delete state.task.error;
  }

  private async appendCompletionEvents(
    input: LocalSubagentRunInput,
    task: LocalSubagentTaskResult,
    includeAgentEvent: boolean,
  ): Promise<void> {
    if (!isFinalLocalSubagentStatus(task.status)) return;
    const time = this.now();
    const taskEvent: EventEnvelope<"agent.task_completed", Extract<ChiliEvent, { type: "agent.task_completed" }>["payload"]> = {
      id: this.id("event"),
      type: "agent.task_completed",
      time,
      sessionId: input.parentSessionId,
      payload: {
        taskId: input.taskId,
        path: input.path,
        runId: input.runId,
        status: task.status,
        generation: input.generation,
        ...(task.summary ? { summary: task.summary } : {}),
        ...(task.error ? { error: task.error.message } : {}),
      },
    };
    const events: ChiliEvent[] = [taskEvent];
    if (includeAgentEvent) {
      const agentEvent: EventEnvelope<"agent.completed", Extract<ChiliEvent, { type: "agent.completed" }>["payload"]> = {
        id: this.id("event"),
        type: "agent.completed",
        time,
        sessionId: input.parentSessionId,
        payload: {
          runId: input.runId,
          path: input.path,
          taskId: input.taskId,
          status: task.status,
          generation: input.generation,
          ...(task.summary ? { summary: task.summary } : {}),
          ...(task.error ? { error: task.error.message } : {}),
        },
      };
      events.push(agentEvent);
    }
    await this.options.store.appendMany(events);
  }

  private async append<TType extends ChiliEvent["type"], TPayload>(
    input: { sessionId: SessionId },
    type: TType,
    payload: TPayload,
  ): Promise<void> {
    const event: EventEnvelope<TType, TPayload> = {
      id: this.id("event"),
      type,
      time: this.now(),
      sessionId: input.sessionId,
      payload,
    };
    await this.options.store.append(event as ChiliEvent);
  }

  private id<T extends string>(prefix: string): T {
    const create = this.options.createId ?? defaultCreateId;
    return create(prefix) as T;
  }

  private now(): TimestampMs {
    return this.options.now ? this.options.now() : timestampNow();
  }
}

export class AgentRunnerSubagentRunner implements LocalSubagentRunner {
  constructor(private readonly options: AgentRunnerSubagentRunnerOptions) {}

  async run(input: LocalSubagentRunInput): Promise<LocalSubagentRunResult> {
    await this.options.runner.createSession({
      sessionId: input.childSessionId,
      cwd: input.cwd,
    });
    await this.options.runner.appendUserMessage({
      sessionId: input.childSessionId,
      text: input.prompt,
    });

    const maxTurns = this.options.maxTurns ?? 128;
    const prompt = await this.resolvePromptAssembly(input);
    let repairAttempted = false;
    let extraRepairTurn = false;
    for (let index = 0; index < maxTurns || extraRepairTurn; index++) {
      extraRepairTurn = false;
      const runInput = runTurnInputFromPrompt(input, prompt);
      if (input.signal) runInput.signal = input.signal;
      const result = await this.options.runner.runTurn(runInput);

      if (result.status !== "completed") {
        return {
          status: result.status,
          error: result.error,
        };
      }

      if (!isToolUseFinishReason(result.finishReason)) {
        const assessment = await this.assessLatestCompletion(input.childSessionId);
        if (assessment.status === "completed") {
          return { status: "completed", summary: assessment.summary };
        }
        if (repairAttempted) return incompleteRunResult(assessment);

        repairAttempted = true;
        await this.options.runner.appendUserMessage({
          sessionId: input.childSessionId,
          text: subagentCompletionRepairPrompt(assessment),
        });
        if (index + 1 >= maxTurns) extraRepairTurn = true;
      }
    }

    const finalPrompt = this.withFinalResponsePrompt(prompt);
    const finalInput: RunTurnInput = {
      sessionId: input.childSessionId,
      cwd: input.cwd,
      system: finalPrompt.system,
      toolMode: "disabled",
    };
    if (finalPrompt.developer.length > 0) finalInput.developer = finalPrompt.developer;
    if (finalPrompt.contextualUser.length > 0) finalInput.contextualUser = finalPrompt.contextualUser;
    finalInput.promptDebug = finalPrompt.debug;
    if (input.signal) finalInput.signal = input.signal;
    const finalResult = await this.options.runner.runTurn(finalInput);
    if (finalResult.status !== "completed") {
      return {
        status: finalResult.status,
        error: finalResult.error,
      };
    }
    if (!isToolUseFinishReason(finalResult.finishReason)) {
      const assessment = await this.assessLatestCompletion(input.childSessionId);
      return assessment.status === "completed"
        ? { status: "completed", summary: assessment.summary }
        : incompleteRunResult(assessment);
    }

    return {
      status: "incomplete",
      error: new Error(`Subagent max-turn final response attempted tool use: ${maxTurns}`),
    };
  }

  private async resolvePromptAssembly(input: LocalSubagentRunInput): Promise<PromptAssembly> {
    const fragments = await this.options.promptFragments?.({
      sessionId: input.childSessionId,
      cwd: input.cwd,
    });
    return new PromptAssembler()
      .addMany(fragments)
      .addMany(subagentRunPromptFragments(input))
      .assemble();
  }

  private withFinalResponsePrompt(prompt: PromptAssembly): PromptAssembly {
    return new PromptAssembler()
      .addMany(prompt.fragments)
      .add({
        id: "subagent.final_response_after_max_turns",
        layer: "base",
        source: "runtime",
        priority: Number.MAX_SAFE_INTEGER,
        lifecycle: "turn",
        trust: "system",
        content: FINAL_RESPONSE_AFTER_MAX_TURNS_SYSTEM,
      })
      .assemble();
  }

  private async latestAssistantText(sessionId: SessionId): Promise<string | undefined> {
    const messages = await this.options.store.messages(sessionId);
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message?.role !== "assistant") continue;
      const text = message.parts
        .filter((part): part is Extract<(typeof message.parts)[number], { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("");
      if (text.trim().length > 0) return text;
    }
    return undefined;
  }

  private async assessLatestCompletion(sessionId: SessionId): Promise<SubagentCompletionAssessment> {
    return assessSubagentCompletion(await this.latestAssistantText(sessionId));
  }
}

function runTurnInputFromPrompt(input: LocalSubagentRunInput, prompt: PromptAssembly): RunTurnInput {
  const runInput: RunTurnInput = {
    sessionId: input.childSessionId,
    cwd: input.cwd,
    system: prompt.system,
    promptDebug: prompt.debug,
  };
  if (prompt.developer.length > 0) runInput.developer = prompt.developer;
  if (prompt.contextualUser.length > 0) runInput.contextualUser = prompt.contextualUser;
  return runInput;
}

function defaultCreateId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}

function subagentRunSystemLine(input: LocalSubagentRunInput): string {
  return [
    `Subagent task id: ${input.taskId}.`,
    `Repository cwd: ${input.cwd}.`,
    `Agent path: ${input.path} (logical agent identifier, not a filesystem path).`,
    "Use repository-relative paths, or absolute paths under the repository cwd; never prefix file paths with the agent path.",
    "When the task is complete, either provide a final concise answer or call complete_task with this task id and a clear summary.",
  ].join(" ");
}

function subagentRunPromptFragments(input: LocalSubagentRunInput): PromptFragment[] {
  const fragments: PromptFragment[] = [
    {
      id: "chili.subagent.base",
      layer: "base",
      source: "core",
      priority: 10,
      lifecycle: "stable",
      trust: "system",
      content:
        "You are a local Chili subagent. Work in the assigned repository scope, keep results concise, and return a clear final summary.",
    },
    {
      id: "chili.subagent.assignment",
      layer: "developer",
      source: "runtime",
      priority: 10,
      lifecycle: "turn",
      trust: "system",
      content: subagentRunSystemLine(input),
    },
  ];
  if (input.workerPolicy) {
    fragments.push({
      id: "chili.subagent.worker_policy",
      layer: "developer",
      source: "runtime",
      priority: 20,
      lifecycle: "turn",
      trust: "system",
      content: workerPolicySystemSummary(input.workerPolicy),
    });
  }
  return fragments;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function abortError(): Error {
  const error = new Error("Local subagent run aborted");
  error.name = "AbortError";
  return error;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

function isFinalLocalSubagentStatus(
  status: LocalSubagentStatus,
): status is Exclude<LocalSubagentStatus, "pending" | "running"> {
  return status !== "pending" && status !== "running";
}

function incompleteRunResult(
  assessment: Extract<SubagentCompletionAssessment, { status: "incomplete" }>,
): LocalSubagentRunResult {
  const result: LocalSubagentRunResult = {
    status: "incomplete",
    error: completionIssueError(assessment),
  };
  if (assessment.summary) result.summary = assessment.summary;
  return result;
}

function completionIssueError(
  assessment: Extract<SubagentCompletionAssessment, { status: "incomplete" }>,
): Error {
  return new Error(`Subagent completion incomplete: ${assessment.issue}`);
}

function isAbortError(error: Error): boolean {
  return error.name === "AbortError" || error.message.toLowerCase().includes("aborted");
}

function isToolUseFinishReason(reason: string | undefined): boolean {
  return reason === "tool_use" || reason === "tool_calls" || reason === "function_call";
}

function leaseOwner(runId: AgentRunId): string {
  return `local:${runId}`;
}

function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  const maybeTimer = timer as ReturnType<typeof setInterval> & { unref?: () => void };
  maybeTimer.unref?.();
}

function eventContext(sessionId: SessionId): { sessionId: SessionId } {
  return { sessionId };
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

function validateSchedulingMetadata(input: LocalSubagentSchedulingMetadata): void {
  if (input.maxConcurrency !== undefined) assertPositiveInteger(input.maxConcurrency, "maxConcurrency");
  if (input.batchIndex !== undefined) assertNonNegativeInteger(input.batchIndex, "batchIndex");
  if (input.expectedBatchSize !== undefined) {
    assertPositiveInteger(input.expectedBatchSize, "expectedBatchSize");
    if (input.batchIndex !== undefined && input.batchIndex >= input.expectedBatchSize) {
      throw new Error("batchIndex must be less than expectedBatchSize");
    }
  }
}

function assignSchedulingMetadata(
  target: LocalSubagentSchedulingMetadata,
  source: LocalSubagentSchedulingMetadata,
): void {
  if (source.sourceCallId !== undefined) target.sourceCallId = source.sourceCallId;
  if (source.batchId !== undefined) target.batchId = source.batchId;
  if (source.batchIndex !== undefined) target.batchIndex = source.batchIndex;
  if (source.expectedBatchSize !== undefined) target.expectedBatchSize = source.expectedBatchSize;
  if (source.maxConcurrency !== undefined) target.maxConcurrency = source.maxConcurrency;
  if (source.completionPolicy !== undefined) target.completionPolicy = source.completionPolicy;
}

function schedulingEventPayload(input: LocalSubagentSchedulingMetadata): Record<string, unknown> {
  return {
    ...(input.sourceCallId !== undefined ? { sourceCallId: input.sourceCallId } : {}),
    ...(input.batchId !== undefined ? { batchId: input.batchId } : {}),
    ...(input.batchIndex !== undefined ? { batchIndex: input.batchIndex } : {}),
    ...(input.expectedBatchSize !== undefined ? { expectedBatchSize: input.expectedBatchSize } : {}),
    ...(input.maxConcurrency !== undefined ? { maxConcurrency: input.maxConcurrency } : {}),
    ...(input.completionPolicy !== undefined ? { completionPolicy: input.completionPolicy } : {}),
  };
}

function fromToolTaskInput(input: TaskToolInput, context: SubagentToolContext): LocalSubagentTaskInput {
  const task: LocalSubagentTaskInput = {
    parentSessionId: context.sessionId,
    cwd: context.cwd,
    taskName: input.description,
    prompt: input.prompt,
    signal: context.signal,
    sourceCallId: context.callId,
  };
  const mode = normalizeToolMode(input.mode);
  if (mode) task.mode = mode;
  if (input.batchId !== undefined) task.batchId = input.batchId;
  if (input.batchIndex !== undefined) task.batchIndex = input.batchIndex;
  if (input.expectedBatchSize !== undefined) task.expectedBatchSize = input.expectedBatchSize;
  if (input.maxConcurrency !== undefined) task.maxConcurrency = input.maxConcurrency;
  if (input.completionPolicy !== undefined) task.completionPolicy = input.completionPolicy;
  return task;
}

function normalizeToolMode(mode: string | undefined): LocalSubagentMode | undefined {
  if (!mode) return undefined;
  if (mode === "one_shot" || mode === "resumable" || mode === "background") return mode;
  return undefined;
}
