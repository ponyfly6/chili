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
import type { EventStore } from "@chili/store";
import type {
  CompleteTaskToolInput,
  SubagentController,
  SubagentTaskCompletion,
  SubagentTaskHandle,
  SubagentToolContext,
  TaskToolInput,
} from "@chili/tools";
import type { AgentRunner } from "./runner.js";

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
  summary?: string;
  error?: Error;
}

export interface LocalSubagentRunner {
  run(input: LocalSubagentRunInput): Promise<LocalSubagentRunResult>;
}

export type LocalSubagentBackgroundErrorHandler = (error: unknown, task: LocalSubagentTaskResult) => void;

export interface LocalSubagentManagerOptions {
  store: EventStore;
  runner: LocalSubagentRunner;
  createId?: (prefix: string) => string;
  now?: () => TimestampMs;
  onBackgroundError?: LocalSubagentBackgroundErrorHandler;
}

interface LocalSubagentTaskState {
  task: LocalSubagentTaskResult;
  runInput: LocalSubagentRunInput;
}

export interface AgentRunnerSubagentRunnerOptions {
  runner: AgentRunner;
  store: EventStore;
  maxTurns?: number;
  system?: string[];
}

export class LocalSubagentManager implements SubagentController {
  private readonly tasks = new Map<string, LocalSubagentTaskState>();

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
    if (state) {
      state.task.status = input.status ?? "completed";
      state.task.summary = input.summary;
      await this.appendTaskCompletion(state.runInput, state.task);
    }
    return {
      taskId: input.taskId,
      summary: input.summary,
      status: input.status ?? "completed",
    };
  }

  private async spawnLocalTask(input: LocalSubagentTaskInput): Promise<LocalSubagentTaskResult> {
    const taskId = this.id<TaskId>("task");
    const runId = this.id<AgentRunId>("agent");
    const parentPath = input.parentPath ?? ROOT_AGENT_PATH;
    const path = joinAgentPath(parentPath, taskId);
    const childSessionId = this.id<SessionId>("session");
    const childThreadId = this.id<ThreadId>("thread");
    const mode = input.mode ?? "one_shot";

    const task: LocalSubagentTaskResult = {
      taskId,
      runId,
      path,
      parentPath,
      childSessionId,
      childThreadId,
      status: "running",
    };

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
        ...(input.parentThreadId ? { parentThreadId: input.parentThreadId } : {}),
        ...(mode ? { mode } : {}),
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
    };
    if (input.parentThreadId) runInput.parentThreadId = input.parentThreadId;
    if (input.signal) runInput.signal = input.signal;
    this.tasks.set(taskId, { task, runInput });

    if (mode === "background") {
      queueMicrotask(() => {
        void this.completeFromRunner(task, runInput).catch((error: unknown) => {
          this.options.onBackgroundError?.(error, task);
        });
      });
      return task;
    }

    return this.completeFromRunner(task, runInput);
  }

  private async completeFromRunner(
    task: LocalSubagentTaskResult,
    input: LocalSubagentRunInput,
  ): Promise<LocalSubagentTaskResult> {
    try {
      const result = await this.options.runner.run(input);
      if (task.status !== "running") {
        await this.appendAgentCompletion(input, task);
        return task;
      }
      task.status = result.status;
      if (result.summary) task.summary = result.summary;
      if (result.error) task.error = result.error;
      await this.appendTaskCompletion(input, task);
      await this.appendAgentCompletion(input, task);
      return task;
    } catch (error) {
      const err = toError(error);
      task.status = isAbortError(err) ? "cancelled" : "failed";
      task.error = err;
      await this.appendTaskCompletion(input, task);
      await this.appendAgentCompletion(input, task);
      return task;
    }
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

    const maxTurns = this.options.maxTurns ?? 12;
    for (let index = 0; index < maxTurns; index++) {
      const runInput = {
        sessionId: input.childSessionId,
        threadId: input.childThreadId,
        cwd: input.cwd,
        system: [
          ...(this.options.system ?? []),
          `Subagent task id: ${input.taskId}. Agent path: ${input.path}. When the task is complete, either provide a final concise answer or call complete_task with this task id and a clear summary.`,
        ],
      };
      if (input.signal) Object.assign(runInput, { signal: input.signal });
      const result = await this.options.runner.runTurn(runInput);

      if (result.status !== "completed") {
        return {
          status: result.status,
          error: result.error,
        };
      }

      if (result.finishReason !== "tool_use") {
        const completed: LocalSubagentRunResult = {
          status: "completed",
        };
        const summary = await this.latestAssistantText(input.childSessionId);
        if (summary) completed.summary = summary;
        return completed;
      }
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

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isAbortError(error: Error): boolean {
  return error.name === "AbortError" || error.message.toLowerCase().includes("aborted");
}

function eventContext(sessionId: SessionId, threadId: ThreadId | undefined): { sessionId: SessionId; threadId?: ThreadId } {
  const context: { sessionId: SessionId; threadId?: ThreadId } = { sessionId };
  if (threadId) context.threadId = threadId;
  return context;
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
