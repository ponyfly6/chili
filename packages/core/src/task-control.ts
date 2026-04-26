import type {
  AgentPath,
  AgentRunId,
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
import type { AgentTaskQuery, AgentTaskRow, EventStore, SubagentProjectionStore } from "@chili/store";
import type { SubmitPromptInput, SubmitPromptResult } from "./runtime-service.js";

export type AgentTaskFinalStatus = Exclude<AgentTaskStatus, "pending" | "running">;

export interface AgentTaskPromptRuntime {
  submitPrompt(input: SubmitPromptInput): Promise<SubmitPromptResult>;
  interrupt(sessionId: SessionId, reason?: string): Promise<boolean>;
}

export interface AgentTaskControlServiceOptions {
  store: EventStore & SubagentProjectionStore;
  runtime: AgentTaskPromptRuntime;
  createId?: (prefix: string) => string;
  now?: () => TimestampMs;
  defaultWaitTimeoutMs?: number;
  pollIntervalMs?: number;
  system?: string[];
}

export interface AgentTaskFollowupInput {
  taskId: TaskId;
  text: string;
  maxTurns?: number;
  system?: string[];
  signal?: AbortSignal;
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

export interface AgentTaskCloseInput {
  taskId: TaskId;
  status?: AgentTaskFinalStatus;
  summary?: string;
  error?: string;
  interrupt?: boolean;
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

export class AgentTaskControlService {
  constructor(private readonly options: AgentTaskControlServiceOptions) {}

  listTasks(query: AgentTaskQuery = {}): Promise<AgentTaskRow[]> {
    return this.options.store.agentTasks(query);
  }

  async getTask(taskId: TaskId): Promise<AgentTaskRow> {
    return this.requireTask(taskId);
  }

  async followupTask(input: AgentTaskFollowupInput): Promise<AgentTaskFollowupResult> {
    const task = await this.requireRunnableTask(input.taskId);
    const runId = this.id<AgentRunId>("agent");

    await this.appendTaskFollowup(task, input.text, runId);
    const result = await this.options.runtime.submitPrompt(this.submitPromptInput(task, input));
    await this.completeFollowupRun(task, runId, result);

    return {
      task: await this.requireTask(input.taskId),
      result,
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

  async closeTask(input: AgentTaskCloseInput): Promise<AgentTaskRow> {
    const task = await this.requireTask(input.taskId);
    if (isFinalTaskStatus(task.status)) return task;

    const status = input.status ?? "cancelled";
    if (input.interrupt !== false && task.childSessionId) {
      await this.options.runtime.interrupt(task.childSessionId, "task_closed");
    }

    await this.appendTaskCompletion(task, status, task.currentRunId as AgentRunId | undefined, input.summary, input.error);
    await this.appendAgentCompletion(task, status, task.currentRunId as AgentRunId | undefined, input.summary, input.error);
    return this.requireTask(input.taskId);
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
    return task;
  }

  private submitPromptInput(task: AgentTaskRow, input: AgentTaskFollowupInput): SubmitPromptInput {
    if (!task.childSessionId || !task.childThreadId) {
      throw new AgentTaskNotRunnableError(task.id, `Agent task is missing child session metadata: ${task.id}`);
    }

    const promptInput: SubmitPromptInput = {
      sessionId: task.childSessionId,
      threadId: task.childThreadId,
      text: input.text,
      system: [
        ...(this.options.system ?? []),
        ...(input.system ?? []),
        `Subagent task id: ${task.id}. Agent path: ${task.path}. This is a follow-up for an existing task; answer in the task context and call complete_task with this task id when finished.`,
      ],
    };
    if (task.cwd) promptInput.cwd = task.cwd;
    if (input.maxTurns !== undefined) promptInput.maxTurns = input.maxTurns;
    if (input.signal) promptInput.signal = input.signal;
    return promptInput;
  }

  private async appendTaskFollowup(task: AgentTaskRow, text: string, runId: AgentRunId): Promise<void> {
    await this.append(task, "agent.message_queued", {
      taskId: task.id,
      path: task.path,
      from: task.parentPath ?? ROOT_AGENT_PATH,
      triggerTurn: true,
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
    });
  }

  private async completeFollowupRun(
    task: AgentTaskRow,
    runId: AgentRunId,
    result: SubmitPromptResult,
  ): Promise<void> {
    const status = promptResultToTaskStatus(result);
    const summary = result.status === "completed" ? await this.latestAssistantText(task.childSessionId) : undefined;
    const error = result.status === "completed" ? undefined : result.error?.message ?? result.finishReason;
    await this.appendTaskCompletion(task, status, runId, summary, error);
    await this.appendAgentCompletion(task, status, runId, summary, error);
  }

  private async appendTaskCompletion(
    task: AgentTaskRow,
    status: AgentTaskFinalStatus,
    runId?: AgentRunId,
    summary?: string,
    error?: string,
  ): Promise<void> {
    await this.append(task, "agent.task_completed", {
      taskId: task.id,
      path: task.path,
      status,
      runId,
      summary,
      error,
    });
  }

  private async appendAgentCompletion(
    task: AgentTaskRow,
    status: AgentTaskFinalStatus,
    runId?: AgentRunId,
    summary?: string,
    error?: string,
  ): Promise<void> {
    if (!runId) return;
    await this.append(task, "agent.completed", {
      runId,
      taskId: task.id,
      path: task.path,
      status,
      summary,
      error,
    });
  }

  private async latestAssistantText(sessionId: SessionId | undefined): Promise<string | undefined> {
    if (!sessionId) return undefined;
    const messages = await this.options.store.messages(sessionId);
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (!message || message.role !== "assistant") continue;
      const text = textFromMessage(message);
      if (text) return text;
    }
    return undefined;
  }

  private async append<TType extends ChiliEvent["type"], TPayload>(
    task: AgentTaskRow,
    type: TType,
    payload: TPayload,
  ): Promise<void> {
    const event: EventEnvelope<TType, TPayload> = {
      id: this.id("event"),
      type,
      time: this.now(),
      payload: pruneUndefined(payload),
    };
    const sessionId = task.parentSessionId ?? task.childSessionId;
    if (sessionId) event.sessionId = sessionId;
    if (task.parentThreadId) event.threadId = task.parentThreadId;
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

function promptResultToTaskStatus(result: SubmitPromptResult): AgentTaskFinalStatus {
  if (result.status === "completed") return "completed";
  if (result.status === "cancelled") return "cancelled";
  return "failed";
}

function isFinalTaskStatus(status: AgentTaskStatus): status is AgentTaskFinalStatus {
  return status === "completed" || status === "failed" || status === "cancelled";
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

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}
