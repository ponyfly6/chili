import type {
  AgentPath,
  AgentRunId,
  ChiliEvent,
  EventEnvelope,
  SessionId,
  TaskId,
  ThreadId,
  TimestampMs,
} from "@chili/protocol";
import { joinAgentPath, ROOT_AGENT_PATH, timestampNow } from "@chili/protocol";
import type { AgentTaskFinalizationStore, AgentTaskLeaseStore, EventStore } from "@chili/store";
import type {
  CompleteTaskToolInput,
  SubagentController,
  SubagentTaskCompletion,
  SubagentTaskHandle,
  SubagentToolContext,
  TaskToolInput,
} from "@chili/tools";
import type { AgentRunner, RunTurnInput } from "./runner.js";
import type { RuntimeSystemContextProvider } from "./runtime-service.js";
import {
  completeWorkerToolPolicy,
  workerPolicySystemSummary,
  type WorkerToolPolicy,
  type WorkerToolPolicyTemplate,
} from "./worker-policy.js";

const FINAL_RESPONSE_AFTER_MAX_TURNS_SYSTEM =
  "The automatic tool-use continuation limit has been reached. Do not call tools. Use the information already available in the conversation to give the best final answer now, and briefly state anything that remains uncertain.";

export type LocalSubagentMode = "one_shot" | "resumable" | "background";
export type LocalSubagentStatus = "running" | "completed" | "failed" | "cancelled";

export interface LocalSubagentTaskInput {
  parentSessionId: SessionId;
  parentThreadId?: ThreadId;
  parentPath?: AgentPath;
  cwd: string;
  taskName: string;
  prompt: string;
  mode?: LocalSubagentMode;
  workerPolicy?: WorkerToolPolicyTemplate;
  signal?: AbortSignal;
}

export interface LocalSubagentRunInput {
  taskId: TaskId;
  runId: AgentRunId;
  path: AgentPath;
  parentPath: AgentPath;
  parentSessionId: SessionId;
  parentThreadId?: ThreadId;
  childSessionId: SessionId;
  childThreadId: ThreadId;
  cwd: string;
  taskName: string;
  prompt: string;
  generation: number;
  workerPolicy?: WorkerToolPolicy;
  signal?: AbortSignal;
}

export interface LocalSubagentRunResult {
  status: Exclude<LocalSubagentStatus, "running">;
  summary?: string;
  error?: Error;
}

export interface LocalSubagentTaskResult {
  taskId: TaskId;
  runId: AgentRunId;
  path: AgentPath;
  parentPath: AgentPath;
  childSessionId: SessionId;
  childThreadId: ThreadId;
  status: LocalSubagentStatus;
  workerPolicy?: WorkerToolPolicy;
  summary?: string;
  error?: Error;
}

export interface LocalSubagentRunner {
  run(input: LocalSubagentRunInput): Promise<LocalSubagentRunResult>;
}

export type LocalSubagentBackgroundErrorHandler = (error: unknown, task: LocalSubagentTaskResult) => void;

export interface LocalSubagentManagerOptions {
  store: EventStore & Partial<AgentTaskLeaseStore> & Partial<AgentTaskFinalizationStore>;
  runner: LocalSubagentRunner;
  createId?: (prefix: string) => string;
  now?: () => TimestampMs;
  onBackgroundError?: LocalSubagentBackgroundErrorHandler;
  leaseTtlMs?: number;
  leaseHeartbeatIntervalMs?: number;
}

interface LocalSubagentTaskState {
  task: LocalSubagentTaskResult;
  runInput: LocalSubagentRunInput;
  controller: AbortController;
  lease?: LocalSubagentTaskLease;
  externallyClosed?: boolean;
}

interface LocalSubagentTaskLease {
  owner: string;
  generation: number;
  ttlMs: number;
  heartbeatIntervalMs: number;
  timer?: ReturnType<typeof setInterval>;
  renewing?: boolean;
  stopped?: boolean;
}

export interface AgentRunnerSubagentRunnerOptions {
  runner: AgentRunner;
  store: EventStore;
  maxTurns?: number;
  system?: string[];
  systemContext?: RuntimeSystemContextProvider;
}

export class LocalSubagentManager implements SubagentController {
  private readonly tasks = new Map<string, LocalSubagentTaskState>();
  private readonly backgroundTasks = new Set<Promise<void>>();

  constructor(private readonly options: LocalSubagentManagerOptions) {}

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
    state.task.status = input.status ?? "completed";
    state.task.summary = input.summary;
    this.stopLeaseHeartbeat(state);
    if (!(await this.completeTaskFinal(state, false))) {
      throw new Error(`Local subagent task finalization lost CAS: ${input.taskId}`);
    }
    state.controller.abort();
    return {
      taskId: input.taskId,
      summary: input.summary,
      status: input.status ?? "completed",
    };
  }

  async waitForBackgroundTasks(): Promise<void> {
    await Promise.allSettled([...this.backgroundTasks]);
  }

  async interruptTask(taskId: TaskId | string): Promise<boolean> {
    const state = this.tasks.get(taskId);
    if (!state) return false;
    state.externallyClosed = true;
    state.task.status = "cancelled";
    this.stopLeaseHeartbeat(state);
    await this.releaseTaskLease(state);
    state.controller.abort();
    return true;
  }

  private async spawnLocalTask(input: LocalSubagentTaskInput): Promise<LocalSubagentTaskResult> {
    const taskId = this.id<TaskId>("task");
    const runId = this.id<AgentRunId>("agent");
    const parentPath = input.parentPath ?? ROOT_AGENT_PATH;
    const path = joinAgentPath(parentPath, taskId);
    const childSessionId = this.id<SessionId>("session");
    const childThreadId = this.id<ThreadId>("thread");
    const mode = input.mode ?? "one_shot";
    const generation = 1;
    const controller = linkedAbortController(input.signal);
    const workerPolicy = input.workerPolicy
      ? completeWorkerToolPolicy(input.workerPolicy, childSessionId, childThreadId)
      : undefined;

    const task: LocalSubagentTaskResult = {
      taskId,
      runId,
      path,
      parentPath,
      childSessionId,
      childThreadId,
      status: "running",
    };
    if (workerPolicy) task.workerPolicy = workerPolicy;

    await this.append(
      eventContext(input.parentSessionId, input.parentThreadId),
      "agent.task_created",
      {
        taskId,
        path,
        parentPath,
        parentSessionId: input.parentSessionId,
        childSessionId,
        childThreadId,
        taskName: input.taskName,
        cwd: input.cwd,
        prompt: input.prompt,
        ...(input.parentThreadId ? { parentThreadId: input.parentThreadId } : {}),
        ...(mode ? { mode } : {}),
        ...(workerPolicy ? { workerPolicy } : {}),
      },
    );

    await this.append(
      eventContext(input.parentSessionId, input.parentThreadId),
      "agent.spawned",
      {
        runId,
        path,
        parentPath,
        taskId,
        parentSessionId: input.parentSessionId,
        childSessionId,
        childThreadId,
        taskName: input.taskName,
        cwd: input.cwd,
        generation,
        ...(input.parentThreadId ? { parentThreadId: input.parentThreadId } : {}),
        ...(mode ? { mode } : {}),
        ...(workerPolicy ? { workerPolicy } : {}),
      },
    );

    const runInput: LocalSubagentRunInput = {
      taskId,
      runId,
      path,
      parentPath,
      parentSessionId: input.parentSessionId,
      childSessionId,
      childThreadId,
      cwd: input.cwd,
      taskName: input.taskName,
      prompt: input.prompt,
      generation,
    };
    if (input.parentThreadId) runInput.parentThreadId = input.parentThreadId;
    if (workerPolicy) runInput.workerPolicy = workerPolicy;
    runInput.signal = controller.signal;

    const lease = await this.claimTaskLease(runInput);
    if (lease) {
      runInput.generation = lease.generation;
    }
    const state: LocalSubagentTaskState = { task, runInput, controller };
    if (lease) {
      state.lease = lease;
      this.startLeaseHeartbeat(state);
    }
    this.tasks.set(taskId, state);

    if (mode === "background") {
      let promise: Promise<void>;
      promise = Promise.resolve().then(async () => {
        try {
          await this.completeFromRunner(state);
        } catch (error: unknown) {
          this.options.onBackgroundError?.(error, task);
        } finally {
          this.backgroundTasks.delete(promise);
        }
      });
      this.backgroundTasks.add(promise);
      return task;
    }

    return this.completeFromRunner(state);
  }

  private async completeFromRunner(state: LocalSubagentTaskState): Promise<LocalSubagentTaskResult> {
    const { task, runInput: input } = state;
    try {
      const result = await this.options.runner.run(input);
      if (state.externallyClosed) return task;
      if (task.status !== "running") {
        this.stopLeaseHeartbeat(state);
        await this.appendAgentCompletion(input, task);
        return task;
      }
      if (!(await this.ensureTaskLease(state))) return task;
      task.status = result.status;
      if (result.summary) task.summary = result.summary;
      if (result.error) task.error = result.error;
      this.stopLeaseHeartbeat(state);
      if (!(await this.completeTaskFinal(state, true))) {
        state.externallyClosed = true;
        task.status = "cancelled";
      }
      return task;
    } catch (error) {
      if (state.externallyClosed) return task;
      if (task.status !== "running") {
        this.stopLeaseHeartbeat(state);
        await this.appendAgentCompletion(input, task);
        return task;
      }
      if (!(await this.ensureTaskLease(state))) return task;
      const err = toError(error);
      task.status = isAbortError(err) ? "cancelled" : "failed";
      task.error = err;
      this.stopLeaseHeartbeat(state);
      if (!(await this.completeTaskFinal(state, true))) {
        state.externallyClosed = true;
        task.status = "cancelled";
      }
      return task;
    } finally {
      this.stopLeaseHeartbeat(state);
    }
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
    if (!lease || lease.stopped || lease.renewing || !store) return;

    lease.renewing = true;
    try {
      const result = await store.renewAgentTaskLease({
        taskId: state.runInput.taskId,
        owner: lease.owner,
        generation: lease.generation,
        ttlMs: lease.ttlMs,
        now: Number(this.now()),
      });
      if (result.acquired) return;
      this.cancelForLeaseLoss(state);
    } finally {
      lease.renewing = false;
    }
  }

  private async ensureTaskLease(state: LocalSubagentTaskState): Promise<boolean> {
    const lease = state.lease;
    const store = this.leaseStore();
    if (!lease || !store) return true;
    if (lease.stopped) return true;

    let result: Awaited<ReturnType<AgentTaskLeaseStore["renewAgentTaskLease"]>>;
    try {
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
    if (result.acquired) return true;
    this.cancelForLeaseLoss(state);
    return false;
  }

  private cancelForLeaseLoss(state: LocalSubagentTaskState, error?: unknown): void {
    state.externallyClosed = true;
    state.task.status = "cancelled";
    this.stopLeaseHeartbeat(state);
    state.controller.abort();
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

  private async completeTaskFinal(state: LocalSubagentTaskState, includeAgentEvent: boolean): Promise<boolean> {
    const { task, runInput: input } = state;
    if (task.status === "running") return false;

    const store = this.finalizationStore();
    if (store) {
      const casInput: Parameters<AgentTaskFinalizationStore["completeAgentTaskCas"]>[0] = {
        taskId: input.taskId,
        path: input.path,
        runId: input.runId,
        status: task.status,
        generation: input.generation,
        eventId: this.id("event"),
        sessionId: input.parentSessionId,
        time: this.now(),
      };
      if (state.lease?.owner) casInput.owner = state.lease.owner;
      if (input.parentThreadId) casInput.threadId = input.parentThreadId;
      if (task.summary) casInput.summary = task.summary;
      if (task.error) casInput.error = task.error.message;
      if (includeAgentEvent) casInput.agentEventId = this.id("event");
      const result = await store.completeAgentTaskCas(casInput);
      return result.applied;
    }

    await this.appendTaskCompletion(input, task);
    if (includeAgentEvent) await this.appendAgentCompletion(input, task);
    return true;
  }

  private leaseStore(): AgentTaskLeaseStore | undefined {
    const store = this.options.store;
    if (store.claimAgentTaskLease && store.renewAgentTaskLease && store.releaseAgentTaskLease) {
      return store as EventStore & AgentTaskLeaseStore;
    }
    return undefined;
  }

  private finalizationStore(): AgentTaskFinalizationStore | undefined {
    const store = this.options.store;
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

  private async appendTaskCompletion(input: LocalSubagentRunInput, task: LocalSubagentTaskResult): Promise<void> {
    if (task.status === "running") return;
    await this.append(
      eventContext(input.parentSessionId, input.parentThreadId),
      "agent.task_completed",
      {
        taskId: input.taskId,
        path: input.path,
        runId: input.runId,
        status: task.status,
        generation: input.generation,
        ...(task.summary ? { summary: task.summary } : {}),
        ...(task.error ? { error: task.error.message } : {}),
      },
    );
  }

  private async appendAgentCompletion(input: LocalSubagentRunInput, task: LocalSubagentTaskResult): Promise<void> {
    if (task.status === "running") return;
    await this.append(
      eventContext(input.parentSessionId, input.parentThreadId),
      "agent.completed",
      {
        runId: input.runId,
        path: input.path,
        taskId: input.taskId,
        status: task.status,
        generation: input.generation,
        ...(task.summary ? { summary: task.summary } : {}),
        ...(task.error ? { error: task.error.message } : {}),
      },
    );
  }

  private async append<TType extends ChiliEvent["type"], TPayload>(
    input: { sessionId: SessionId; threadId?: ThreadId },
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
    if (input.threadId) event.threadId = input.threadId;
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
      threadId: input.childThreadId,
      cwd: input.cwd,
    });
    await this.options.runner.appendUserMessage({
      sessionId: input.childSessionId,
      threadId: input.childThreadId,
      text: input.prompt,
    });

    const maxTurns = this.options.maxTurns ?? 128;
    const dynamicSystem = await this.options.systemContext?.({
      sessionId: input.childSessionId,
      threadId: input.childThreadId,
      cwd: input.cwd,
    }) ?? [];
    const baseSystem = [
      ...(this.options.system ?? []),
      ...dynamicSystem,
      subagentRunSystemLine(input),
      ...(input.workerPolicy ? [workerPolicySystemSummary(input.workerPolicy)] : []),
    ];
    for (let index = 0; index < maxTurns; index++) {
      const runInput: RunTurnInput = {
        sessionId: input.childSessionId,
        threadId: input.childThreadId,
        cwd: input.cwd,
        system: baseSystem,
      };
      if (input.signal) runInput.signal = input.signal;
      const result = await this.options.runner.runTurn(runInput);

      if (result.status !== "completed") {
        return {
          status: result.status,
          error: result.error,
        };
      }

      if (!isToolUseFinishReason(result.finishReason)) {
        const completed: LocalSubagentRunResult = {
          status: "completed",
        };
        const summary = await this.latestAssistantText(input.childSessionId);
        if (summary) completed.summary = summary;
        return completed;
      }
    }

    const finalInput: RunTurnInput = {
      sessionId: input.childSessionId,
      threadId: input.childThreadId,
      cwd: input.cwd,
      system: [...baseSystem, FINAL_RESPONSE_AFTER_MAX_TURNS_SYSTEM],
      toolMode: "disabled",
    };
    if (input.signal) finalInput.signal = input.signal;
    const finalResult = await this.options.runner.runTurn(finalInput);
    if (finalResult.status !== "completed") {
      return {
        status: finalResult.status,
        error: finalResult.error,
      };
    }
    if (!isToolUseFinishReason(finalResult.finishReason)) {
      const completed: LocalSubagentRunResult = {
        status: "completed",
      };
      const summary = await this.latestAssistantText(input.childSessionId);
      if (summary) completed.summary = summary;
      return completed;
    }

    return {
      status: "failed",
      error: new Error(`Subagent exceeded max turns: ${maxTurns}`),
    };
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

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
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

function eventContext(sessionId: SessionId, threadId: ThreadId | undefined): { sessionId: SessionId; threadId?: ThreadId } {
  const context: { sessionId: SessionId; threadId?: ThreadId } = { sessionId };
  if (threadId) context.threadId = threadId;
  return context;
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

function fromToolTaskInput(input: TaskToolInput, context: SubagentToolContext): LocalSubagentTaskInput {
  const task: LocalSubagentTaskInput = {
    parentSessionId: context.sessionId,
    cwd: context.cwd,
    taskName: input.description,
    prompt: input.prompt,
    signal: context.signal,
  };
  const threadId = toolContextThreadId(context);
  if (threadId) task.parentThreadId = threadId;
  const mode = normalizeToolMode(input.mode);
  if (mode) task.mode = mode;
  return task;
}

function toolContextThreadId(context: SubagentToolContext): ThreadId | undefined {
  return (context as SubagentToolContext & { threadId?: ThreadId }).threadId;
}

function normalizeToolMode(mode: string | undefined): LocalSubagentMode | undefined {
  if (!mode) return undefined;
  if (mode === "one_shot" || mode === "resumable" || mode === "background") return mode;
  return undefined;
}
