import {
  USER_INPUT_LIMITS,
  normalizePersistedError,
  parseUserInputAnswers,
  parseUserInputQuestions,
  timestampNow,
  type PendingUserInputRequest,
  type SessionId,
  type ToolCallId,
  type ToolResult,
  type UserInputAnswers,
  type UserInputId,
  type UserInputQuestion,
} from "@chili/protocol";
import type { ChiliToolDefinition, ToolEventSink, ValidationResult } from "./types.js";

const DEFAULT_MAX_PENDING_USER_INPUTS = 128;

export interface DeferredUserInputQueueOptions {
  maxPending?: number;
}

export interface ListDeferredUserInputsInput {
  sessionId?: SessionId;
}

export interface ResolveDeferredUserInputInput {
  inputId: UserInputId;
  answers: UserInputAnswers;
}

interface PendingUserInput {
  request: PendingUserInputRequest;
  resolve(answers: UserInputAnswers): void;
  reject(error: Error): void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class UserInputDeniedError extends Error {
  constructor(message = "User input request was denied.") {
    super(message);
    this.name = "UserInputDeniedError";
  }
}

/** In-memory rendezvous between a running request_user_input tool and a control client. */
export class DeferredUserInputQueue {
  private readonly pending = new Map<UserInputId, PendingUserInput>();
  private readonly maxPending: number;

  constructor(options: DeferredUserInputQueueOptions = {}) {
    const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING_USER_INPUTS;
    if (!Number.isSafeInteger(maxPending) || maxPending < 1) {
      throw new TypeError("maxPending must be a positive safe integer");
    }
    this.maxPending = maxPending;
  }

  ask(request: PendingUserInputRequest, signal?: AbortSignal): Promise<UserInputAnswers> {
    if (signal?.aborted) return Promise.reject(userInputAbortReason(signal));
    const normalized = normalizePendingRequest(request);
    if (this.pending.has(normalized.id)) throw new Error(`User input request is already pending: ${normalized.id}`);
    if (this.pending.size >= this.maxPending) {
      throw new Error(`User input queue capacity exceeded (${this.maxPending})`);
    }

    return new Promise<UserInputAnswers>((resolve, reject) => {
      const pending: PendingUserInput = { request: normalized, resolve, reject };
      if (signal) {
        pending.signal = signal;
        pending.onAbort = () => {
          if (!this.pending.delete(normalized.id)) return;
          this.cleanup(pending);
          reject(userInputAbortReason(signal));
        };
        signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      this.pending.set(normalized.id, pending);
    });
  }

  list(input: ListDeferredUserInputsInput | SessionId = {}): PendingUserInputRequest[] {
    const sessionId = typeof input === "string" ? input : input.sessionId;
    return [...this.pending.values()]
      .map((pending) => pending.request)
      .filter((request) => !sessionId || request.sessionId === sessionId)
      .map(clonePendingRequest);
  }

  resolve(input: ResolveDeferredUserInputInput): boolean {
    const pending = this.pending.get(input.inputId);
    if (!pending) return false;
    const answers = parseUserInputAnswers(input.answers, pending.request.questions);
    this.pending.delete(input.inputId);
    this.cleanup(pending);
    pending.resolve(answers);
    return true;
  }

  deny(inputId: UserInputId, reason: unknown = "User input request was denied."): boolean {
    const pending = this.pending.get(inputId);
    if (!pending) return false;
    this.pending.delete(inputId);
    this.cleanup(pending);
    pending.reject(userInputDeniedReason(reason));
    return true;
  }

  denyAll(reason: unknown = "User input queue closed."): void {
    for (const inputId of [...this.pending.keys()]) this.deny(inputId, reason);
  }

  private cleanup(pending: PendingUserInput): void {
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
  }
}

export interface RequestUserInputToolInput {
  questions: UserInputQuestion[];
}

export function createRequestUserInputTool(
  queue: DeferredUserInputQueue,
  events: ToolEventSink,
  createId: (prefix: string) => string,
): ChiliToolDefinition<RequestUserInputToolInput, ToolResult> {
  return {
    name: "request_user_input",
    description:
      "Ask the user one to three short questions and wait for their answers. Use only when continuing requires a user choice.",
    resourcePolicy: "internal",
    risk: "read",
    isReadOnly: true,
    isConcurrencySafe: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["questions"],
      properties: {
        questions: {
          type: "array",
          minItems: 1,
          maxItems: USER_INPUT_LIMITS.questions,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "header", "question", "options"],
            properties: {
              id: { type: "string", minLength: 1, maxLength: USER_INPUT_LIMITS.questionIdChars },
              header: { type: "string", minLength: 1, maxLength: USER_INPUT_LIMITS.headerChars },
              question: { type: "string", minLength: 1, maxLength: USER_INPUT_LIMITS.questionChars },
              multiple: { type: "boolean" },
              options: {
                type: "array",
                minItems: 2,
                maxItems: USER_INPUT_LIMITS.options,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["label", "description"],
                  properties: {
                    label: { type: "string", minLength: 1, maxLength: USER_INPUT_LIMITS.optionLabelChars },
                    description: {
                      type: "string",
                      minLength: 1,
                      maxLength: USER_INPUT_LIMITS.optionDescriptionChars,
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    validate(input): ValidationResult<RequestUserInputToolInput> {
      if (!isRecord(input)) return { ok: false, message: "input must be an object" };
      const unknown = Object.keys(input).find((key) => key !== "questions");
      if (unknown) return { ok: false, message: `input contains an unexpected field: ${unknown}` };
      try {
        return { ok: true, value: { questions: parseUserInputQuestions(input.questions) } };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
    approval: () => false,
    async execute(input, context) {
      const inputId = createId("userinput") as UserInputId;
      const createdAt = timestampNow();
      const outcome = queue.ask({
        id: inputId,
        sessionId: context.sessionId,
        callId: context.callId,
        questions: input.questions,
        createdAt,
      }, context.signal).then<UserInputOutcome, UserInputOutcome>(
        (answers) => ({ ok: true, answers }),
        (error) => ({ ok: false, error }),
      );

      try {
        await events.publish({
          id: createId("event"),
          type: "user_input.requested",
          time: createdAt,
          sessionId: context.sessionId,
          payload: { inputId, callId: context.callId, questions: input.questions },
        });
      } catch (error) {
        queue.deny(inputId, error);
        await outcome;
        throw error;
      }

      const answerOutcome = await outcome;
      if (!answerOutcome.ok) {
        const error = normalizePersistedError(answerOutcome.error);
        await events.publish({
          id: createId("event"),
          type: "user_input.cancelled",
          time: timestampNow(),
          sessionId: context.sessionId,
          payload: { inputId, ...(error.message ? { reason: error.message } : {}) },
        });
        throw error;
      }
      await events.publish({
        id: createId("event"),
        type: "user_input.resolved",
        time: timestampNow(),
        sessionId: context.sessionId,
        payload: { inputId, answers: answerOutcome.answers },
      });

      const result = { inputId, answers: answerOutcome.answers };
      return {
        title: "User input received",
        output: JSON.stringify(result, null, 2),
        metadata: result,
      };
    },
  };
}

type UserInputOutcome =
  | { ok: true; answers: UserInputAnswers }
  | { ok: false; error: unknown };

function normalizePendingRequest(request: PendingUserInputRequest): PendingUserInputRequest {
  const id = queueIdentifier(request.id, "id") as UserInputId;
  const sessionId = queueIdentifier(request.sessionId, "sessionId") as SessionId;
  const callId = queueIdentifier(request.callId, "callId") as ToolCallId;
  if (typeof request.createdAt !== "number" || !Number.isFinite(request.createdAt) || request.createdAt < 0) {
    throw new TypeError("createdAt must be a non-negative finite number");
  }
  return {
    id,
    sessionId,
    callId,
    questions: parseUserInputQuestions(request.questions),
    createdAt: request.createdAt,
  };
}

function clonePendingRequest(request: PendingUserInputRequest): PendingUserInputRequest {
  return {
    ...request,
    questions: request.questions.map((question) => ({
      ...question,
      options: question.options.map((option) => ({ ...option })),
    })),
  };
}

function queueIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${field} must be a non-empty string`);
  if (value.length > 512) throw new TypeError(`${field} must not exceed 512 characters`);
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`${field} must not contain control characters`);
  return value.trim();
}

function userInputAbortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("User input request aborted");
  error.name = "AbortError";
  return error;
}

function userInputDeniedReason(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new UserInputDeniedError(typeof reason === "string" && reason.trim() ? reason : undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
