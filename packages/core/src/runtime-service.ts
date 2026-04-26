import type {
  ChiliEvent,
  EventEnvelope,
  MessageId,
  RuntimeSessionStatus,
  SessionId,
  ThreadId,
  TimestampMs,
  TurnId,
} from "@chili/protocol";
import { timestampNow } from "@chili/protocol";
import type { EventStore } from "@chili/store";
import type { AgentRunner, RunTurnResult } from "./runner.js";

export interface RuntimeServiceOptions {
  runtime: AgentRunner;
  store: EventStore;
  cwd: string;
  maxTurns?: number;
  system?: string[];
  createId?: (prefix: string) => string;
  now?: () => TimestampMs;
}

export interface CreateRuntimeSessionInput {
  sessionId?: SessionId;
  threadId?: ThreadId;
  cwd?: string;
}

export interface RuntimeSessionHandle {
  sessionId: SessionId;
  threadId: ThreadId;
}

export interface SubmitPromptInput {
  sessionId: SessionId;
  threadId: ThreadId;
  text: string;
  cwd?: string;
  maxTurns?: number;
  system?: string[];
  signal?: AbortSignal;
}

export type SubmitPromptResult =
  | {
      status: "completed";
      turns: RunTurnResult[];
      finishReason?: string;
    }
  | {
      status: "failed" | "cancelled" | "max_turns";
      turns: RunTurnResult[];
      error?: Error;
      finishReason?: string;
    };

export type RuntimeBackgroundErrorHandler = (error: unknown) => void;

export class RuntimeBusyError extends Error {
  constructor(readonly sessionId: SessionId) {
    super(`Session is already running: ${sessionId}`);
    this.name = "RuntimeBusyError";
  }
}

export class RuntimeService {
  private readonly running = new Map<SessionId, AbortController>();

  constructor(private readonly options: RuntimeServiceOptions) {}

  async createSession(input: CreateRuntimeSessionInput = {}): Promise<RuntimeSessionHandle> {
    const threadId = input.threadId ?? this.id<ThreadId>("thread");
    const createInput: {
      sessionId?: SessionId;
      threadId: ThreadId;
      cwd: string;
    } = {
      threadId,
      cwd: input.cwd ?? this.options.cwd,
    };
    if (input.sessionId) createInput.sessionId = input.sessionId;
    const sessionId = await this.options.runtime.createSession(createInput);
    await this.publishStatus({ sessionId, threadId, status: "idle", reason: "session_created" });
    return { sessionId, threadId };
  }

  appendUserMessage(input: { sessionId: SessionId; threadId: ThreadId; text: string }): Promise<MessageId> {
    return this.options.runtime.appendUserMessage(input);
  }

  async submitPrompt(input: SubmitPromptInput): Promise<SubmitPromptResult> {
    if (this.running.has(input.sessionId)) {
      throw new RuntimeBusyError(input.sessionId);
    }

    const controller = this.createRunController(input);
    return this.runReservedPrompt(input, controller);
  }

  submitPromptAsync(input: SubmitPromptInput, onError?: RuntimeBackgroundErrorHandler): void {
    if (this.running.has(input.sessionId)) {
      throw new RuntimeBusyError(input.sessionId);
    }

    const controller = this.createRunController(input);
    queueMicrotask(() => {
      void this.runReservedPrompt(input, controller).catch((error: unknown) => {
        onError?.(error);
      });
    });
  }

  isRunning(sessionId: SessionId): boolean {
    return this.running.has(sessionId);
  }

  private async runReservedPrompt(input: SubmitPromptInput, controller: AbortController): Promise<SubmitPromptResult> {
    const turns: RunTurnResult[] = [];
    const maxTurns = input.maxTurns ?? this.options.maxTurns ?? 12;
    const system = input.system ?? this.options.system ?? [];
    const cwd = input.cwd ?? this.options.cwd;

    try {
      await this.publishStatus({
        sessionId: input.sessionId,
        threadId: input.threadId,
        status: "running",
        reason: "prompt_submitted",
      });

      await this.options.runtime.appendUserMessage({
        sessionId: input.sessionId,
        threadId: input.threadId,
        text: input.text,
      });

      for (let index = 0; index < maxTurns; index++) {
        if (controller.signal.aborted) {
          return await this.cancelledPrompt(input, turns, "Prompt aborted");
        }

        const result = await this.options.runtime.runTurn({
          sessionId: input.sessionId,
          threadId: input.threadId,
          cwd,
          system,
          signal: controller.signal,
        });
        turns.push(result);

        const turnStatus: {
          sessionId: SessionId;
          threadId: ThreadId;
          status: RuntimeSessionStatus;
          turnId: TurnId;
          reason?: string;
        } = {
          sessionId: input.sessionId,
          threadId: input.threadId,
          status: result.status === "completed" ? "running" : result.status,
          turnId: result.turnId,
        };
        const turnReason = result.status === "completed" ? result.finishReason : result.error.message;
        if (turnReason) turnStatus.reason = turnReason;
        await this.publishStatus(turnStatus);

        if (result.status !== "completed") {
          return {
            status: result.status,
            turns,
            error: result.error,
          };
        }

        if (controller.signal.aborted) {
          return await this.cancelledPrompt(input, turns, "Prompt aborted");
        }

        if (result.finishReason !== "tool_use") {
          const idleStatus: {
            sessionId: SessionId;
            threadId: ThreadId;
            status: RuntimeSessionStatus;
            turnId: TurnId;
            reason?: string;
          } = {
            sessionId: input.sessionId,
            threadId: input.threadId,
            status: "idle",
            turnId: result.turnId,
          };
          if (result.finishReason) idleStatus.reason = result.finishReason;
          await this.publishStatus(idleStatus);

          const completed: Extract<SubmitPromptResult, { status: "completed" }> = {
            status: "completed",
            turns,
          };
          if (result.finishReason) completed.finishReason = result.finishReason;
          return completed;
        }
      }

      await this.publishStatus({
        sessionId: input.sessionId,
        threadId: input.threadId,
        status: "failed",
        reason: "max_turns",
      });
      return {
        status: "max_turns",
        turns,
        finishReason: "tool_use",
      };
    } catch (error) {
      const err = toError(error);
      const status: Extract<RuntimeSessionStatus, "cancelled" | "failed"> = isAbortError(err) ? "cancelled" : "failed";
      await this.publishStatus({
        sessionId: input.sessionId,
        threadId: input.threadId,
        status,
        reason: err.message,
      });
      return {
        status,
        turns,
        error: err,
      };
    } finally {
      this.running.delete(input.sessionId);
    }
  }

  async interrupt(sessionId: SessionId, reason = "user_interrupt"): Promise<boolean> {
    const controller = this.running.get(sessionId);
    if (!controller) return false;
    await this.publishStatus({ sessionId, status: "cancelling", reason });
    controller.abort();
    return true;
  }

  async archiveSession(sessionId: SessionId): Promise<void> {
    await this.append({ sessionId }, "session.archived", { sessionId });
  }

  private async cancelledPrompt(
    input: SubmitPromptInput,
    turns: RunTurnResult[],
    reason: string,
  ): Promise<SubmitPromptResult> {
    const error = abortError(reason);
    await this.publishStatus({
      sessionId: input.sessionId,
      threadId: input.threadId,
      status: "cancelled",
      reason,
    });
    return {
      status: "cancelled",
      turns,
      error,
    };
  }

  private createRunController(input: SubmitPromptInput): AbortController {
    const controller = new AbortController();
    if (input.signal) {
      if (input.signal.aborted) {
        controller.abort();
      } else {
        input.signal.addEventListener("abort", () => controller.abort(), { once: true });
      }
    }
    this.running.set(input.sessionId, controller);
    return controller;
  }

  private async publishStatus(input: {
    sessionId: SessionId;
    threadId?: ThreadId;
    status: RuntimeSessionStatus;
    turnId?: TurnId;
    reason?: string;
  }): Promise<void> {
    const payload: {
      sessionId: SessionId;
      status: RuntimeSessionStatus;
      turnId?: TurnId;
      reason?: string;
    } = {
      sessionId: input.sessionId,
      status: input.status,
    };
    if (input.turnId) payload.turnId = input.turnId;
    if (input.reason) payload.reason = input.reason;
    await this.append(input, "session.status_changed", payload);
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

function defaultCreateId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function isAbortError(error: Error): boolean {
  return error.name === "AbortError" || error.message.toLowerCase().includes("aborted");
}
