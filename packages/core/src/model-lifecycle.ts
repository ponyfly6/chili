import type { SessionId, TurnId } from "@chili/protocol";
import { addModelUsage } from "./model-usage.js";
import type { ModelRequestPurpose, ModelRouter, ModelStreamEvent, ModelStreamInput, ModelUsage } from "./runtime.js";

export type ModelAgentRole = "root" | "child" | "reviewer" | "unknown";

export interface ModelLifecycleScope {
  agentRole?: ModelAgentRole;
  parentSessionId?: SessionId;
}

export interface ModelLifecycleContext {
  readonly requestId: string;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly purpose: ModelRequestPurpose;
  readonly agentRole: ModelAgentRole;
  readonly parentSessionId?: SessionId;
  readonly startedAt: number;
}

export interface ModelLifecycleOutcome {
  readonly context: ModelLifecycleContext;
  readonly status: "completed" | "failed" | "cancelled" | "incomplete";
  readonly termination: "finish" | "error" | "throw" | "abort" | "end" | "return";
  readonly endedAt: number;
  readonly durationMs: number;
  readonly usage?: ModelUsage;
  readonly finishReason?: string;
  readonly error?: unknown;
  readonly provider?: string;
  readonly model?: string;
  readonly responseId?: string;
}

/** Synchronous observers only. They cannot alter or veto provider execution. */
export interface ModelLifecycleHooks {
  started?(context: ModelLifecycleContext): void;
  event?(context: ModelLifecycleContext, event: ModelStreamEvent): void;
  ended?(outcome: ModelLifecycleOutcome): void;
}

export interface ModelLifecycleDiagnostic {
  readonly point: "context" | keyof ModelLifecycleHooks;
  readonly context: ModelLifecycleContext;
  readonly error: unknown;
}

export interface ModelLifecycleOptions {
  /** Resolve each invocation independently; never consult a mutable current-request slot. */
  resolveContext?(input: ModelStreamInput): ModelLifecycleScope | Promise<ModelLifecycleScope>;
  onError?(diagnostic: ModelLifecycleDiagnostic): void;
  now?: () => number;
}

/**
 * Observe the original stream, retaining its backpressure, exceptions, and cleanup.
 * No retry, deadline, request rewriting, public event publication, or detached drain
 * is introduced here. A consumer stopping after finish still closes the iterator.
 */
export function withModelLifecycle(
  router: ModelRouter,
  hooks: ModelLifecycleHooks,
  options: ModelLifecycleOptions = {},
): ModelRouter {
  const disabled = new Set<keyof ModelLifecycleHooks>();
  const observers: ModelLifecycleHooks = {
    ...(hooks.started ? { started: hooks.started.bind(hooks) } : {}),
    ...(hooks.event ? { event: hooks.event.bind(hooks) } : {}),
    ...(hooks.ended ? { ended: hooks.ended.bind(hooks) } : {}),
  };
  const now = options.now ?? Date.now;
  let reporting = false;

  function report(point: ModelLifecycleDiagnostic["point"], context: ModelLifecycleContext, error: unknown): void {
    if (reporting) return;
    reporting = true;
    try {
      consumeRejection(options.onError?.({ point, context, error }));
    } catch {
      // Diagnostic observers have no authority over the request either.
    } finally {
      reporting = false;
    }
  }

  function observe(point: keyof ModelLifecycleHooks, context: ModelLifecycleContext, call: () => unknown): void {
    if (disabled.has(point)) return;
    try {
      if (consumeRejection(call())) throw new TypeError(`Model ${point} observers must be synchronous.`);
    } catch (error) {
      disabled.add(point);
      report(point, context, error);
    }
  }

  async function* stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
    const base: ModelLifecycleContext = Object.freeze({
      requestId: crypto.randomUUID(), sessionId: input.sessionId, turnId: input.turnId,
      purpose: input.purpose ?? "task", agentRole: "root", startedAt: now(),
    });
    let context = base;
    try {
      const scope = options.resolveContext
        ? await resolveWithSignal(() => options.resolveContext!(input), input.signal)
        : undefined;
      if (scope) context = Object.freeze({
        ...base,
        ...(scope.agentRole ? { agentRole: scope.agentRole } : {}),
        ...(scope.parentSessionId ? { parentSessionId: scope.parentSessionId } : {}),
      });
    } catch (error) {
      context = Object.freeze({ ...base, agentRole: "unknown" });
      report("context", context, error);
    }
    if (observers.started) observe("started", context, () => observers.started!(context));

    let exhausted = false;
    let thrown = false;
    let sawError = false;
    let error: unknown;
    let finishReason: string | undefined;
    let provider: string | undefined;
    let model: string | undefined;
    let responseId: string | undefined;
    const usages = new Map<string, ModelUsage>();
    try {
      // Context lookup can be interrupted before the provider owns its deadline.
      input.signal?.throwIfAborted();
      // for-await forwards consumer return to the provider iterator before finally.
      for await (const event of router.stream(input)) {
        if (event.type === "metadata" || event.type === "finish" || event.type === "error") {
          if (event.responseId) {
            // Early usage metadata may precede the provider's response id.
            if (!responseId && usages.has("")) {
              usages.set(event.responseId, usages.get("")!);
              usages.delete("");
            }
            responseId = event.responseId;
          }
          if (event.usage) usages.set(responseId ?? "", mergeUsageSnapshot(usages.get(responseId ?? ""), event.usage));
          if (event.type === "metadata") {
            provider = event.provider ?? provider;
            model = event.model ?? model;
          } else if (event.type === "finish") {
            finishReason = event.reason;
          } else {
            sawError = true;
            error = event.error;
          }
        }
        // Raw stream payloads are copied only for an active event subscriber.
        if (observers.event && !disabled.has("event")) {
          observe("event", context, () => observers.event!(context, snapshot(event)));
        }
        yield event;
      }
      exhausted = true;
    } catch (cause) {
      thrown = true;
      error = cause;
      throw cause;
    } finally {
      const terminalReason = finishReason?.trim().toLowerCase();
      const cancelled = input.signal?.aborted === true || isAbortError(error)
        || terminalReason === "cancelled" || terminalReason === "canceled";
      const failed = sawError || terminalReason === "error";
      const status = cancelled ? "cancelled" : thrown || failed ? "failed"
        : finishReason !== undefined ? "completed" : "incomplete";
      const termination = cancelled ? "abort" : thrown ? "throw" : failed ? "error"
        : finishReason !== undefined ? "finish" : exhausted ? "end" : "return";
      if (observers.ended) {
        const endedAt = now();
        let usage: ModelUsage | undefined;
        for (const value of usages.values()) usage = addModelUsage(usage, value);
        const outcome: ModelLifecycleOutcome = {
          context, status, termination, endedAt, durationMs: Math.max(0, endedAt - context.startedAt),
          ...(usage ? { usage } : {}),
          ...(finishReason !== undefined ? { finishReason } : {}),
          ...(thrown || sawError ? { error } : {}),
          ...(provider !== undefined ? { provider } : {}),
          ...(model !== undefined ? { model } : {}),
          ...(responseId !== undefined ? { responseId } : {}),
        };
        observe("ended", context, () => observers.ended!(snapshot(outcome)));
      }
    }
  }

  return {
    stream,
    ...(router.listModels ? { listModels: () => router.listModels!() } : {}),
    ...(router.resolveRequestLimits ? { resolveRequestLimits: (input) => router.resolveRequestLimits!(input) } : {}),
  };
}

/** Usage events are cumulative snapshots per response, never token deltas. */
function mergeUsageSnapshot(previous: ModelUsage | undefined, next: ModelUsage): ModelUsage {
  const result: ModelUsage = { ...previous };
  for (const field of ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "totalTokens"] as const) {
    const value = next[field];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) result[field] = value;
  }
  if (next.raw !== undefined) result.raw = next.raw;
  return result;
}

function consumeRejection(value: unknown): boolean {
  if ((typeof value === "object" && value !== null || typeof value === "function")
    && typeof (value as { then?: unknown }).then === "function") {
    void Promise.resolve(value).catch(() => undefined);
    return true;
  }
  return false;
}

function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === "AbortError";
}

function resolveWithSignal<T>(operation: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return Promise.resolve().then(operation);
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener("abort", aborted);
      reject(signal.reason ?? new DOMException("Model context resolution aborted.", "AbortError"));
    };
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    else Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }).then(
      (value) => { signal.removeEventListener("abort", aborted); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", aborted); reject(error); },
    );
  });
}

/** Snapshot observer data without exposing mutable provider-owned objects. */
function snapshot<T>(value: T, ancestors = new Set<object>()): T {
  if (typeof value === "function") return "[Function]" as T;
  if (typeof value === "symbol" || typeof value === "bigint") return String(value) as T;
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) return "[Circular]" as T;
  ancestors.add(value);
  try {
    const copy: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
    if (value instanceof DOMException) {
      // Invoke only the native accessors, never accessors supplied by the error.
      Object.assign(copy, {
        name: Object.getOwnPropertyDescriptor(DOMException.prototype, "name")!.get!.call(value),
        message: Object.getOwnPropertyDescriptor(DOMException.prototype, "message")!.get!.call(value),
      });
    } else if (value instanceof Error) {
      let name = "Error";
      for (let prototype: object | null = value; prototype !== null; prototype = Object.getPrototypeOf(prototype)) {
        const property = Object.getOwnPropertyDescriptor(prototype, "name");
        if (!property) continue;
        if ("value" in property && typeof property.value === "string") name = property.value;
        break;
      }
      Object.assign(copy, { name });
    }
    for (const key of Object.getOwnPropertyNames(value)) {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property || Array.isArray(copy) && key === "length") continue;
      Object.defineProperty(copy, key, {
        value: "value" in property ? snapshot(property.value, ancestors) : "[Accessor]", enumerable: true,
      });
    }
    return Object.freeze(copy) as T;
  } catch {
    // Unknown provider error/raw values must not prevent terminal observation.
    return "[Uninspectable]" as T;
  } finally {
    ancestors.delete(value);
  }
}
