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
import {
  boundPersistedJsonValue,
  joinAgentPath,
  normalizePersistedError,
  PERSISTED_JSON_LIMITS,
  ROOT_AGENT_PATH,
  timestampNow,
} from "@chili/protocol";
import type {
  AgentTaskAdmissionStore,
  AgentTaskCapabilityStore,
  AgentTaskFinalizationStore,
  AgentTaskLeaseStore,
  AgentTaskRow,
  AgentTaskRunClaimStore,
  EventAppendOptions,
  EventStore,
  SessionRunClaimFence,
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
const AGENT_EVENT_TEXT_JSON_BYTES = 64 * 1024;
const AGENT_EVENT_METADATA_JSON_BYTES = 256 * 1024;

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
  /** Reserved durable identity. Team dispatch supplies all four fields together. */
  dispatchId?: string;
  taskId?: TaskId;
  runId?: AgentRunId;
  childSessionId?: SessionId;
  /** Owner-session lease fencing the durable task creation marker. */
  runClaim?: SessionRunClaimFence;
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
  reservationFingerprint?: string;
  reservedInitial?: boolean;
  admittedInitial?: boolean;
  admission?: Promise<void>;
  lease?: LocalSubagentTaskLease;
  batchLimiter?: RetainedBatchLimiter;
  spawned?: boolean;
  externalFinalization?: Promise<void>;
  externallyClosed?: boolean;
  finalizationCommitted?: boolean;
  leaseLost?: boolean;
  beginRun?: Promise<boolean>;
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

export class LocalSubagentManagerClosedError extends Error {
  constructor() {
    super("Local subagent manager is closing or closed");
    this.name = "LocalSubagentManagerClosedError";
  }
}

export class LocalSubagentManager implements SubagentController {
  private readonly tasks = new Map<string, LocalSubagentTaskState>();
  private readonly reservedSpawns = new Map<string, {
    fingerprint: string;
    promise: Promise<LocalSubagentTaskResult>;
  }>();
  private readonly backgroundTasks = new Set<Promise<void>>();
  private readonly taskOperations = new Set<Promise<void>>();
  private readonly batchLimiters = new Map<string, BatchLimiterEntry>();
  private readonly runLimiter: LocalSubagentRunLimiter;
  private readonly shutdownController = new AbortController();
  private acceptingTasks = true;
  private shutdownPromise?: Promise<void>;
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
    const summary = boundedPersistedText(input.summary, "subagent summary");
    let completionStatus = input.status ?? "completed";
    if (completionStatus === "completed") {
      const assessment = assessSubagentCompletion(summary);
      if (assessment.status === "incomplete") {
        completionStatus = "incomplete";
        state.task.error = completionIssueError(assessment);
      }
    }
    state.task.status = completionStatus;
    state.task.summary = summary;
    this.stopLeaseHeartbeat(state);
    if (!(await this.completeTaskFinal(state))) {
      state.externallyClosed = true;
      state.controller.abort();
      throw new Error(`Local subagent task finalization lost CAS: ${input.taskId}`);
    }
    state.controller.abort();
    return {
      taskId: input.taskId,
      summary,
      status: completionStatus,
    };
  }

  async waitForBackgroundTasks(): Promise<void> {
    await Promise.allSettled([...this.backgroundTasks]);
  }

  shutdown(reason = "runtime_closed"): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;

    let resolveShutdown!: () => void;
    let rejectShutdown!: (error: unknown) => void;
    const shutdownPromise = new Promise<void>((resolve, reject) => {
      resolveShutdown = resolve;
      rejectShutdown = reject;
    });
    // Abort listeners run synchronously and may reenter shutdown. Publish the
    // one host-level promise before closing admission or notifying any runner.
    this.shutdownPromise = shutdownPromise;

    // Close admission and abort pre-registration work synchronously. A spawn
    // that already passed the public gate is tracked in taskOperations and is
    // linked to this controller before its first await.
    this.acceptingTasks = false;
    this.shutdownController.abort(abortError(reason));
    void (async () => {
      while (true) {
        const activeTaskIds = [...this.tasks.values()]
          .filter((state) => !isFinalLocalSubagentStatus(state.task.status))
          .map((state) => state.task.taskId);
        await Promise.allSettled(activeTaskIds.map((taskId) => this.interruptTask(taskId)));

        const operations = [...this.taskOperations];
        const background = [...this.backgroundTasks];
        if (operations.length === 0 && background.length === 0) break;
        await Promise.allSettled([...operations, ...background]);
      }
    })().then(resolveShutdown, rejectShutdown);
    return shutdownPromise;
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

  liveTaskIds(): TaskId[] {
    const ids = new Set<TaskId>();
    for (const state of this.tasks.values()) {
      if (!isFinalLocalSubagentStatus(state.task.status)) ids.add(state.task.taskId);
    }
    for (const taskId of this.reservedSpawns.keys()) ids.add(taskId as TaskId);
    return [...ids];
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
    // Keep ownership alive until pending durable operations have drained.
    state.controller.abort();
    if (state.admission) {
      try { await state.admission; } catch { /* The admitting caller reports its error. */ }
    }
    if (state.beginRun) {
      try {
        await state.beginRun;
      } catch {
        // The normal runner path owns reporting begin failures. Waiting here is
        // only a fence so closure observes any CAS that may already have committed.
      }
    }
    const finalization = this.beginExternalFinalization(state, "cancelled");
    await finalization;
    // A rejected/expired closure must retain its durable recovery evidence.
    if (state.finalizationCommitted) await this.releaseTaskLease(state);
    return true;
  }

  private spawnLocalTask(input: LocalSubagentTaskInput): Promise<LocalSubagentTaskResult> {
    if (!this.acceptingTasks) return Promise.reject(new LocalSubagentManagerClosedError());
    input = boundedLocalSubagentTaskInput(input);
    validateReservedTaskIdentity(input);
    if (!input.taskId) return this.trackTaskOperation(this.spawnLocalTaskOnce(input));

    const fingerprint = reservedTaskFingerprint(input);
    const active = this.tasks.get(input.taskId);
    if (active) {
      if (active.reservationFingerprint !== fingerprint) {
        return Promise.reject(new Error(
          `Local subagent task reservation conflicts with an active task: ${input.taskId}`,
        ));
      }
      return Promise.resolve({ ...active.task });
    }
    const existing = this.reservedSpawns.get(input.taskId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(new Error(
          `Local subagent task reservation conflicts with an in-flight spawn: ${input.taskId}`,
        ));
      }
      return existing.promise;
    }

    const promise = this.trackTaskOperation(this.spawnLocalTaskOnce(input));
    this.reservedSpawns.set(input.taskId, { fingerprint, promise });
    void promise.finally(() => {
      const current = this.reservedSpawns.get(input.taskId as TaskId);
      if (current?.promise === promise) this.reservedSpawns.delete(input.taskId as TaskId);
    }).catch(() => undefined);
    return promise;
  }

  private trackTaskOperation<T>(operation: Promise<T>): Promise<T> {
    let observed: Promise<void>;
    observed = operation.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      this.taskOperations.delete(observed);
    });
    this.taskOperations.add(observed);
    return operation;
  }

  private async spawnLocalTaskOnce(input: LocalSubagentTaskInput): Promise<LocalSubagentTaskResult> {
    const controller = linkedAbortController(input.signal, this.shutdownController.signal);
    await this.options.assertDelegationEnabled?.({
      sessionId: input.parentSessionId,
      action: "task.spawn",
    });
    throwIfAborted(controller.signal);
    const taskId = input.taskId ?? this.id<TaskId>("task");
    const runId = input.runId ?? this.id<AgentRunId>("agent");
    const parentPath = input.parentPath ?? ROOT_AGENT_PATH;
    const path = joinAgentPath(parentPath, taskId);
    const childSessionId = input.childSessionId ?? this.id<SessionId>("session");
    const mode = input.mode ?? "one_shot";
    let generation = 1;
    const batchLimiter = this.retainBatchLimiter(input);
    const assertSpawnActive = (): void => {
      if (!controller.signal.aborted) return;
      this.releaseBatchLimiter(batchLimiter);
      throwIfAborted(controller.signal);
    };
    const workerPolicy = input.workerPolicy
      ? completeWorkerToolPolicy(input.workerPolicy, childSessionId)
      : undefined;

    let task: LocalSubagentTaskResult = {
      taskId,
      runId,
      path,
      parentPath,
      childSessionId,
      status: "pending",
    };
    if (workerPolicy) task.workerPolicy = workerPolicy;
    assignSchedulingMetadata(task, input);

    const existingTask = input.taskId ? await this.projectedTask(input.taskId) : undefined;
    assertSpawnActive();
    if (existingTask) {
      task = localTaskResultFromProjection(existingTask, input, {
        taskId,
        runId,
        path,
        parentPath,
        childSessionId,
        ...(workerPolicy ? { workerPolicy } : {}),
      });
      if (
        task.status === "running"
        && (existingTask.leaseExpiresAt === undefined
          || existingTask.leaseExpiresAt <= Number(this.now()))
      ) {
        const finalizationStore = this.finalizationStore();
        if (finalizationStore) {
          const closeInput: Parameters<AgentTaskFinalizationStore["closeAgentTaskCas"]>[0] = {
            taskId: existingTask.id,
            status: "incomplete",
            eventId: this.id("event"),
            expectedGeneration: existingTask.generation,
            expectedRunId: (existingTask.currentRunId as AgentRunId | undefined) ?? null,
            expectedLeaseOwner: existingTask.leaseOwner ?? null,
            requireExpiredLease: true,
            summary: "Reserved worker lease expired before recovery",
            error: "reserved_worker_lease_expired",
            sessionId: input.parentSessionId,
            time: this.now(),
          };
          if (existingTask.leaseExpiresAt !== undefined) {
            closeInput.expectedLeaseExpiresAt = existingTask.leaseExpiresAt;
          }
          if (existingTask.currentRunId) closeInput.agentEventId = this.id("event");
          if (input.runClaim) closeInput.runClaim = input.runClaim;
          const closed = await finalizationStore.closeAgentTaskCas(closeInput);
          const authoritative = closed.task ?? await this.projectedTask(existingTask.id);
          if (authoritative) {
            task = localTaskResultFromProjection(authoritative, input, {
              taskId,
              runId,
              path,
              parentPath,
              childSessionId,
              ...(workerPolicy ? { workerPolicy } : {}),
            });
          }
        }
      }
      if (task.status !== "pending") {
        this.releaseBatchLimiter(batchLimiter);
        return task;
      }
      generation = Math.max(existingTask.generation + 1, 1);
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

    const state: LocalSubagentTaskState = {
      task,
      runInput,
      controller,
      ...(input.taskId ? { reservationFingerprint: reservedTaskFingerprint(input) } : {}),
      ...(input.dispatchId ? { reservedInitial: true } : {}),
    };
    if (batchLimiter) state.batchLimiter = batchLimiter;

    if (!existingTask) {
      assertSpawnActive();
      try {
        const event: Extract<ChiliEvent, { type: "agent.task_created" }> = {
          id: this.id("event"),
          type: "agent.task_created",
          time: this.now(),
          sessionId: input.parentSessionId,
          payload: {
            taskId,
            ...(input.dispatchId ? { dispatchId: input.dispatchId } : {}),
            ...(input.runId ? { reservedRunId: input.runId } : {}),
            path,
            parentPath,
            parentSessionId: input.parentSessionId,
            childSessionId,
            taskName: input.taskName,
            cwd: input.cwd,
            prompt: input.prompt,
            ...(mode ? { mode } : {}),
            ...(workerPolicy ? { workerPolicy: { ...workerPolicy } } : {}),
            ...schedulingEventPayload(input),
          },
        };
        const teamWorker = typeof workerPolicy?.teamId === "string" && workerPolicy.teamId.length > 0
          && typeof workerPolicy.taskId === "string" && workerPolicy.taskId.length > 0;
        const admissionStore = !input.dispatchId && !teamWorker ? this.admissionStore() : undefined;
        if (admissionStore) {
          const ttlMs = this.options.leaseTtlMs ?? 30_000;
          const admittedAt = Number(this.now());
          state.admittedInitial = true;
          state.lease = {
            owner: `admission:v1:${crypto.randomUUID()}`,
            generation: 0,
            expiresAt: admittedAt + ttlMs,
            ttlMs,
            heartbeatIntervalMs: this.leaseHeartbeatIntervalMs(ttlMs),
          };
          this.tasks.set(taskId, state);
          // The SQL transaction commits before its transcript mirror settles.
          // Own and renew the pending reservation throughout that await too.
          this.startLeaseHeartbeat(state);
          const admission = (async () => {
            const result = await admissionStore.admitAgentTask({
              event,
              owner: state.lease!.owner,
              ttlMs,
              now: admittedAt,
              ...(input.runClaim ? { runClaim: input.runClaim } : {}),
            });
            if (!result.applied) throw new Error(`Local subagent admission conflicts with an existing task: ${taskId}`);
          })();
          state.admission = admission;
          try { await admission; } finally { delete state.admission; }
        } else {
          await this.options.store.append(event, input.runClaim ? { runClaim: input.runClaim } : undefined);
        }
      } catch (error) {
        if (state.admittedInitial) {
          await this.beginExternalFinalization(state, "failed", toError(error)).catch((failure) => {
            this.options.onBackgroundError?.(failure, task);
          });
          if (this.tasks.get(taskId) === state) this.tasks.delete(taskId);
        }
        this.releaseBatchLimiter(batchLimiter);
        throw error;
      }
    }
    if (input.dispatchId && !this.runClaimStore()) {
      this.releaseBatchLimiter(batchLimiter);
      throw new Error(
        `Reserved local subagent task requires atomic run-claim capability: ${taskId}`,
      );
    }
    this.tasks.set(taskId, state);

    if (mode === "background") {
      let promise: Promise<void>;
      promise = Promise.resolve().then(async () => {
        try {
          await this.completeFromRunner(state);
        } catch (error: unknown) {
          this.options.onBackgroundError?.(toError(error), task);
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
      try {
        const beginRun = this.beginTaskRun(state);
        state.beginRun = beginRun;
        if (!(await beginRun)) return task;
      } catch (error) {
        // A failed acknowledgement can follow a committed initial CAS. Read
        // only our exact token/run before deciding how to settle that work.
        if (state.admittedInitial) {
          const current = await this.projectedTask(input.taskId);
          if (current) this.adoptAdmittedRun(state, current);
        }
        if (!state.externallyClosed && !state.spawned) task.status = "pending";
        throw error;
      } finally {
        delete state.beginRun;
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
        if (input.signal?.aborted && !state.externallyClosed) throw abortError();
        await state.externalFinalization;
        return task;
      }

      if (state.externallyClosed) {
        await state.externalFinalization;
        return task;
      }
      if (input.signal?.aborted) throw abortError();
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
        if (input.signal?.aborted && !state.externallyClosed) throw abortError();
        await state.externalFinalization;
        return task;
      }
      task.status = result.status;
      if (result.summary) task.summary = boundedPersistedText(result.summary, "subagent summary");
      if (result.error) task.error = toError(result.error);
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
      // A caller-aborted runner still owns terminal settlement. Cancellation
      // must prevent provider entry, without bypassing this fresh lease CAS.
      if (!(await this.ensureTaskLease(state, true))) {
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

  private async beginTaskRun(state: LocalSubagentTaskState): Promise<boolean> {
    const input = state.runInput;
    const atomicStore = state.reservedInitial || state.admittedInitial ? this.runClaimStore() : undefined;
    if ((state.reservedInitial || state.admittedInitial) && !atomicStore) {
      throw new Error(
        `Reserved local subagent task requires atomic run-claim capability: ${input.taskId}`,
      );
    }
    if (atomicStore) {
      const ttlMs = this.options.leaseTtlMs ?? 30_000;
      const owner = state.admittedInitial ? state.lease!.owner : leaseOwner(input.runId);
      const result = await atomicStore.beginAgentTaskRunCas({
        taskId: input.taskId,
        expectedGeneration: 0,
        expectedRunId: null,
        expectedLeaseOwner: state.admittedInitial ? owner : null,
        runId: input.runId,
        generation: 1,
        leaseOwner: owner,
        leaseTtlMs: ttlMs,
        spawnEventId: this.id("event"),
        ...(state.admittedInitial ? { admittedInitial: true } : { reservedInitial: true }),
        sessionId: input.parentSessionId,
        time: this.now(),
      });
      if (!result.applied) {
        const authoritative = result.task ?? await this.projectedTask(input.taskId);
        if (authoritative) this.hydrateAuthoritativeTask(state, authoritative);
        if (this.tasks.get(input.taskId) === state) this.tasks.delete(input.taskId);
        return false;
      }
      const task = result.task ?? await this.projectedTask(input.taskId);
      if (!task || task.leaseExpiresAt === undefined) {
        throw new Error(`Reserved local subagent task began without a durable lease: ${input.taskId}`);
      }
      if (state.admittedInitial && !this.adoptAdmittedRun(state, task)) {
        this.hydrateAuthoritativeTask(state, task);
        state.externallyClosed = true;
        if (this.tasks.get(input.taskId) === state) this.tasks.delete(input.taskId);
        return false;
      }
      input.generation = task.generation;
      state.spawned = true;
      if (state.lease) {
        state.lease.generation = task.generation;
        state.lease.expiresAt = task.leaseExpiresAt;
      } else {
        state.lease = {
          owner,
          generation: task.generation,
          expiresAt: task.leaseExpiresAt,
          ttlMs,
          heartbeatIntervalMs: this.leaseHeartbeatIntervalMs(ttlMs),
        };
      }
      this.startLeaseHeartbeat(state);
      return true;
    }

    await this.appendAgentSpawned(state);
    state.spawned = true;
    const lease = await this.claimTaskLease(input);
    if (lease) {
      input.generation = lease.generation;
      state.lease = lease;
      this.startLeaseHeartbeat(state);
    }
    return true;
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
    if (error) state.task.error = toError(error);
    this.stopLeaseHeartbeat(state);
    state.externalFinalization = this.finalizeExternalClosure(state);
    return state.externalFinalization;
  }

  private async finalizeExternalClosure(state: LocalSubagentTaskState): Promise<void> {
    // Optional capability wrappers may delay before the durable commit. A
    // cancelled local placeholder cannot settle until that admission (or its
    // initial run transition) has either committed or rejected.
    if (state.admission) {
      try { await state.admission; } catch { /* The admitting caller reports its error. */ }
    }
    if (state.beginRun) {
      try { await state.beginRun; } catch { /* The runner path reports its error. */ }
    }
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
    if (this.hasCurrentLeaseReceipt(lease, result)) {
      lease.expiresAt = result.task!.leaseExpiresAt!;
      return;
    }
    this.cancelForLeaseLoss(state);
  }

  private async ensureTaskLease(state: LocalSubagentTaskState, allowAborted = false): Promise<boolean> {
    const lease = state.lease;
    const store = this.leaseStore();
    if (!lease || !store) return true;
    if (lease.stopped) return false;

    let result: Awaited<ReturnType<AgentTaskLeaseStore["renewAgentTaskLease"]>>;
    try {
      // A heartbeat may have committed before the ownership check was
      // requested. Drain it, then issue a fresh CAS for this runner boundary.
      if (lease.renewal) await lease.renewal;
      if (lease.stopped || state.externallyClosed || (!allowAborted && state.controller.signal.aborted)) return false;
      result = await store.renewAgentTaskLease({
        taskId: state.runInput.taskId,
        owner: lease.owner,
        generation: lease.generation,
        ttlMs: lease.ttlMs,
        now: Number(this.now()),
      });
    } catch (error) {
      this.cancelForLeaseLoss(state, error);
      return false;
    }
    if (this.hasCurrentLeaseReceipt(lease, result) && result.task!.status === "running"
      && result.task!.currentRunId === state.runInput.runId) {
      lease.expiresAt = result.task!.leaseExpiresAt!;
      return !state.externallyClosed && (allowAborted || !state.controller.signal.aborted);
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
    const generation = lease.generation;
    const renewal = (async () => {
      let result = await store.renewAgentTaskLease({
        taskId: state.runInput.taskId,
        owner: lease.owner,
        generation,
        ttlMs: lease.ttlMs,
        now: Number(this.now()),
      });
      const ownInitialTransition = !result.acquired && generation === 0 && result.task
        && this.adoptAdmittedRun(state, result.task);
      if (!lease.stopped && (ownInitialTransition || (result.acquired && !this.hasCurrentLeaseReceipt(lease, result)))) {
        // A delayed receipt may belong to gen0 after gen1 started, or may have
        // expired while awaiting its acknowledgement. Recheck the current
        // generation before that receipt can authorize a runner or settlement.
        result = await store.renewAgentTaskLease({
          taskId: state.runInput.taskId,
          owner: lease.owner,
          generation: lease.generation,
          ttlMs: lease.ttlMs,
          now: Number(this.now()),
        });
      }
      return result;
    })();
    lease.renewal = renewal;
    try {
      return await renewal;
    } finally {
      if (lease.renewal === renewal) delete lease.renewal;
    }
  }

  private hasCurrentLeaseReceipt(
    lease: LocalSubagentTaskLease,
    result: Awaited<ReturnType<AgentTaskLeaseStore["renewAgentTaskLease"]>>,
  ): boolean {
    const task = result.task;
    return result.acquired && task !== undefined
      && (task.status === "pending" || task.status === "running")
      && task.leaseOwner === lease.owner && task.generation === lease.generation
      && task.leaseExpiresAt !== undefined && task.leaseExpiresAt > Number(this.now());
  }

  private adoptAdmittedRun(state: LocalSubagentTaskState, task: AgentTaskRow): boolean {
    const lease = state.lease;
    if (!state.admittedInitial || !lease || task.status !== "running"
      || task.currentRunId !== state.runInput.runId || task.generation !== 1
      || task.leaseOwner !== lease.owner || task.leaseExpiresAt === undefined) return false;
    state.spawned = true;
    state.runInput.generation = task.generation;
    lease.generation = task.generation;
    lease.expiresAt = task.leaseExpiresAt;
    return true;
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

  private admissionStore(): AgentTaskAdmissionStore | undefined {
    const store = this.options.store as EventStore & Partial<AgentTaskAdmissionStore> & Partial<AgentTaskCapabilityStore>;
    if (store.supportsAgentTaskCapability?.("admission") === false) return undefined;
    // Admission requires the full lease lifecycle; embedded legacy stores keep
    // their original append path rather than receiving an unusable reservation.
    if (!this.leaseStore() || !this.runClaimStore() || !this.finalizationStore()) return undefined;
    return store.admitAgentTask ? store as EventStore & AgentTaskAdmissionStore : undefined;
  }

  private runClaimStore(): AgentTaskRunClaimStore | undefined {
    const store = this.options.store;
    const capabilityStore = store as EventStore & Partial<AgentTaskCapabilityStore>;
    if (capabilityStore.supportsAgentTaskCapability?.("run-claim") === false) return undefined;
    if ((store as Partial<AgentTaskRunClaimStore>).beginAgentTaskRunCas) {
      return store as EventStore & AgentTaskRunClaimStore;
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

  private async projectedTask(taskId: TaskId): Promise<AgentTaskRow | undefined> {
    const projection = this.options.store.agentTask;
    if (!projection) return undefined;
    return projection.call(this.options.store, taskId);
  }

  private leaseHeartbeatIntervalMs(ttlMs: number): number {
    const configured = this.options.leaseHeartbeatIntervalMs;
    if (configured !== undefined) return Math.max(1, configured);
    return Math.max(1, Math.floor(ttlMs / 3));
  }

  private hydrateAuthoritativeTask(state: LocalSubagentTaskState, authoritative: AgentTaskRow): void {
    state.task.status = authoritative.status;
    if (authoritative.summary !== undefined) {
      state.task.summary = boundedPersistedText(authoritative.summary, "subagent summary");
    }
    else delete state.task.summary;
    if (authoritative.error !== undefined) state.task.error = normalizePersistedError(authoritative.error);
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
        ...(task.summary ? { summary: boundedPersistedText(task.summary, "subagent summary") } : {}),
        ...(task.error ? { error: normalizePersistedError(task.error).message } : {}),
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
          ...(task.summary ? { summary: boundedPersistedText(task.summary, "subagent summary") } : {}),
          ...(task.error ? { error: normalizePersistedError(task.error).message } : {}),
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
    options?: EventAppendOptions,
  ): Promise<void> {
    const event: EventEnvelope<TType, TPayload> = {
      id: this.id("event"),
      type,
      time: this.now(),
      sessionId: input.sessionId,
      payload,
    };
    await this.options.store.append(event as ChiliEvent, options);
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
    throwIfRunAborted(input);
    await this.options.runner.createSession({
      sessionId: input.childSessionId,
      cwd: input.cwd,
    });
    throwIfRunAborted(input);
    await this.options.runner.appendUserMessage({
      sessionId: input.childSessionId,
      text: input.prompt,
    });
    throwIfRunAborted(input);

    const maxTurns = this.options.maxTurns ?? 128;
    const prompt = await this.resolvePromptAssembly(input);
    throwIfRunAborted(input);
    let repairAttempted = false;
    let extraRepairTurn = false;
    for (let index = 0; index < maxTurns || extraRepairTurn; index++) {
      extraRepairTurn = false;
      const runInput = runTurnInputFromPrompt(input, prompt);
      if (input.signal) runInput.signal = input.signal;
      throwIfRunAborted(input);
      const result = await this.options.runner.runTurn(runInput);
      throwIfRunAborted(input);

      if (result.status !== "completed") {
        return result.error === undefined
          ? { status: result.status }
          : { status: result.status, error: normalizePersistedError(result.error) };
      }

      if (!isToolUseFinishReason(result.finishReason)) {
        const assessment = await this.assessLatestCompletion(input.childSessionId);
        throwIfRunAborted(input);
        if (assessment.status === "completed") {
          return { status: "completed", summary: boundedPersistedText(assessment.summary, "subagent summary") };
        }
        if (repairAttempted) return incompleteRunResult(assessment);

        repairAttempted = true;
        await this.options.runner.appendUserMessage({
          sessionId: input.childSessionId,
          text: subagentCompletionRepairPrompt(assessment),
        });
        throwIfRunAborted(input);
        if (index + 1 >= maxTurns) extraRepairTurn = true;
      }
    }

    throwIfRunAborted(input);
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
    throwIfRunAborted(input);
    const finalResult = await this.options.runner.runTurn(finalInput);
    throwIfRunAborted(input);
    if (finalResult.status !== "completed") {
      return finalResult.error === undefined
        ? { status: finalResult.status }
        : { status: finalResult.status, error: normalizePersistedError(finalResult.error) };
    }
    if (!isToolUseFinishReason(finalResult.finishReason)) {
      const assessment = await this.assessLatestCompletion(input.childSessionId);
      throwIfRunAborted(input);
      return assessment.status === "completed"
        ? { status: "completed", summary: boundedPersistedText(assessment.summary, "subagent summary") }
        : incompleteRunResult(assessment);
    }

    return {
      status: "incomplete",
      error: new Error(`Subagent max-turn final response attempted tool use: ${maxTurns}`),
    };
  }

  private async resolvePromptAssembly(input: LocalSubagentRunInput): Promise<PromptAssembly> {
    throwIfRunAborted(input);
    const fragments = await this.options.promptFragments?.({
      sessionId: input.childSessionId,
      cwd: input.cwd,
    });
    throwIfRunAborted(input);
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

function validateReservedTaskIdentity(input: LocalSubagentTaskInput): void {
  const reservation = [input.dispatchId, input.taskId, input.runId, input.childSessionId];
  const present = reservation.filter((value) => value !== undefined).length;
  if (present !== 0 && present !== reservation.length) {
    throw new Error("Crash-safe dispatch reservations require dispatchId, taskId, runId, and childSessionId together");
  }
  if (input.dispatchId !== undefined && input.dispatchId.trim().length === 0) {
    throw new Error("dispatchId must not be empty");
  }
}

function reservedTaskFingerprint(input: LocalSubagentTaskInput): string {
  return canonicalJson({
    dispatchId: input.dispatchId,
    taskId: input.taskId,
    runId: input.runId,
    childSessionId: input.childSessionId,
    parentSessionId: input.parentSessionId,
    parentPath: input.parentPath ?? ROOT_AGENT_PATH,
    cwd: input.cwd,
    taskName: input.taskName,
    prompt: input.prompt,
    mode: input.mode ?? "one_shot",
    workerPolicy: input.workerPolicy,
    ...schedulingEventPayload(input),
  });
}

function localTaskResultFromProjection(
  projected: AgentTaskRow,
  input: LocalSubagentTaskInput,
  expected: {
    taskId: TaskId;
    runId: AgentRunId;
    path: AgentPath;
    parentPath: AgentPath;
    childSessionId: SessionId;
    workerPolicy?: WorkerToolPolicy;
  },
): LocalSubagentTaskResult {
  const mode = input.mode ?? "one_shot";
  const identityMatches = Boolean(input.dispatchId)
    && projected.dispatchId === input.dispatchId
    && projected.reservedRunId === expected.runId
    && projected.id === expected.taskId
    && projected.path === expected.path
    && projected.parentPath === expected.parentPath
    && projected.parentSessionId === input.parentSessionId
    && projected.childSessionId === expected.childSessionId
    && projected.taskName === input.taskName
    && projected.cwd === input.cwd
    && projected.prompt === input.prompt
    && projected.mode === mode
    && canonicalJson(projected.workerPolicy) === canonicalJson(expected.workerPolicy)
    && projected.sourceCallId === input.sourceCallId
    && projected.batchId === input.batchId
    && projected.batchIndex === input.batchIndex
    && projected.expectedBatchSize === input.expectedBatchSize
    && projected.maxConcurrency === input.maxConcurrency
    && projected.completionPolicy === input.completionPolicy
    && (!projected.currentRunId || projected.currentRunId === expected.runId);
  if (!identityMatches) {
    throw new Error(`Local subagent task already exists with a different creation identity: ${expected.taskId}`);
  }

  const result: LocalSubagentTaskResult = {
    taskId: projected.id,
    runId: expected.runId,
    path: projected.path,
    parentPath: expected.parentPath,
    childSessionId: expected.childSessionId,
    status: projected.status,
  };
  if (expected.workerPolicy) result.workerPolicy = expected.workerPolicy;
  if (projected.summary) result.summary = boundedPersistedText(projected.summary, "subagent summary");
  if (projected.error) result.error = normalizePersistedError(projected.error);
  assignSchedulingMetadata(result, projected);
  return result;
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
  return normalizePersistedError(error);
}

function abortError(message = "Local subagent run aborted"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason !== undefined) throw normalizePersistedError(signal.reason);
  throw abortError();
}

function throwIfRunAborted(input: LocalSubagentRunInput): void {
  if (input.signal) throwIfAborted(input.signal);
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
    error: normalizePersistedError(completionIssueError(assessment)),
  };
  if (assessment.summary) {
    result.summary = boundedPersistedText(assessment.summary, "subagent summary");
  }
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

function boundedLocalSubagentTaskInput(input: LocalSubagentTaskInput): LocalSubagentTaskInput {
  const bounded: LocalSubagentTaskInput = {
    ...input,
    cwd: boundedPersistedText(input.cwd, "subagent cwd"),
    taskName: boundedPersistedText(input.taskName, "subagent task name"),
    prompt: boundedPersistedText(input.prompt, "subagent prompt"),
  };
  if (input.workerPolicy) {
    bounded.workerPolicy = boundedPersistedRecord(
      input.workerPolicy,
      "subagent worker policy",
    ) as WorkerToolPolicyTemplate;
  }
  if (input.batchId !== undefined) {
    bounded.batchId = boundedPersistedText(input.batchId, "subagent batch id");
  }
  return bounded;
}

function boundedPersistedText(value: string, label: string): string {
  const bounded = boundPersistedJsonValue(value, {
    maxBytes: AGENT_EVENT_TEXT_JSON_BYTES,
    maxStringBytes: AGENT_EVENT_TEXT_JSON_BYTES - 2,
    maxItems: 1,
    maxDepth: 1,
    maxNodes: 1,
    label,
  });
  return typeof bounded === "string" ? bounded : "";
}

function boundedPersistedRecord(value: Record<string, unknown>, label: string): Record<string, unknown> {
  const bounded = boundPersistedJsonValue(value, {
    maxBytes: AGENT_EVENT_METADATA_JSON_BYTES,
    maxStringBytes: PERSISTED_JSON_LIMITS.stringBytes,
    maxItems: PERSISTED_JSON_LIMITS.items,
    maxDepth: PERSISTED_JSON_LIMITS.depth,
    maxNodes: PERSISTED_JSON_LIMITS.nodes,
    label,
  });
  return bounded && typeof bounded === "object" && !Array.isArray(bounded)
    ? bounded as Record<string, unknown>
    : {};
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

function linkedAbortController(...signals: Array<AbortSignal | undefined>): AbortController {
  const controller = new AbortController();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
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
