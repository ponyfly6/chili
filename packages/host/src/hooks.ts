import type {
  AgentLifecycleHooks, ModelLifecycleHooks, PromptFragment, RuntimeModelChangedInput, RuntimePromptFragmentsProvider,
} from "@chili/core";
import type { RuntimeEvent } from "@chili/protocol";
import { validateToolResultPresentation } from "@chili/tools";
import type { ToolLifecycleHooks, ToolReviewRequest, ToolReviewResult } from "@chili/tools";

export type HostPromptContext = Omit<Parameters<RuntimePromptFragmentsProvider>[0], "signal"> & {
  agentKind: "root" | "child";
};

/** Internal, constructor-time capabilities. A module cannot wrap or replay execution. */
export interface HostModule {
  readonly id: string;
  readonly timeoutMs?: number;
  readonly prompt?: {
    collect(context: HostPromptContext, signal: AbortSignal): readonly PromptFragment[] | Promise<readonly PromptFragment[]>;
  };
  readonly tools?: ToolLifecycleHooks & {
    review?(request: ToolReviewRequest, signal: AbortSignal): ToolReviewResult | Promise<ToolReviewResult>;
  };
  readonly model?: ModelLifecycleHooks;
  readonly agent?: AgentLifecycleHooks;
  readonly runtime?: {
    event(event: RuntimeEvent): void;
    eventTypes?: readonly RuntimeEvent["type"][];
  };
  /** Required completion work after a committed setting change; survives host abort. */
  readonly modelSelection?: {
    changed(input: RuntimeModelChangedInput, signal: AbortSignal): void | Promise<void>;
  };
}

export type HostHookPoint = "prompt.collect" | "tools.review" | "tools.processResult" | "tools.ended"
  | "model.started" | "model.event" | "model.ended" | "agent.started" | "agent.ended"
  | "runtime.event" | "model.context" | "modelSelection.changed";

export interface HostHookDiagnostic {
  moduleId: string;
  point: HostHookPoint;
  error: Error;
}

export class HostHookError extends Error {
  constructor(readonly moduleId: string, readonly point: HostHookPoint, cause: unknown) {
    super(`Host module "${moduleId}" (${point}) failed: ${errorMessage(cause)}`, { cause });
    this.name = "HostHookError";
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;
const CAPABILITIES = {
  prompt: ["collect"], tools: ["review", "processResult", "ended"], model: ["started", "event", "ended"],
  agent: ["started", "ended"], runtime: ["event"], modelSelection: ["changed"],
} as const;

/** Fixed ordered dispatch; the executor and runtime retain ownership of their operations. */
export class HostModuleRegistry {
  readonly observesRuntime: boolean;
  readonly toolLifecycle: ToolLifecycleHooks;
  readonly modelLifecycle: ModelLifecycleHooks;
  readonly agentLifecycle: AgentLifecycleHooks;
  private readonly modules: readonly HostModule[];
  private readonly disabledObservers = new Set<string>();
  private readonly lifecycle = new AbortController();
  private readonly onError: ((diagnostic: HostHookDiagnostic) => void) | undefined;
  private closed = false;
  private reporting = false;

  constructor(options: {
    builtins?: readonly HostModule[];
    modules?: readonly HostModule[];
    onError?: (diagnostic: HostHookDiagnostic) => void;
  } = {}) {
    this.onError = options.onError;
    const ids = new Set<string>();
    this.modules = Object.freeze([
      ...(options.builtins ?? []).map((module) => captureModule(module, true, ids)),
      ...(options.modules ?? []).map((module) => captureModule(module, false, ids)),
    ]);
    this.observesRuntime = this.modules.some((module) => !!module.runtime?.event);
    this.toolLifecycle = Object.freeze({
      ...(this.modules.some((module) => module.tools?.processResult) ? {
        processResult: async (context, result, signal) => {
          const captured = copyData(context, true);
          let current = copyData(result, true);
          for (const module of this.modules) {
            if (!module.tools?.processResult) continue;
            current = await this.runAwaited(module, "tools.processResult", async (hookSignal) => {
              const value = await module.tools!.processResult!(captured, current, hookSignal);
              const presentation = validateToolResultPresentation(value);
              // Execution metadata and structured program results stay canonical at every stage.
              const { content: _previousContent, ...canonical } = current;
              return copyData({ ...canonical, ...presentation }, true);
            }, signal);
          }
          return copyData(current, false);
        },
      } satisfies ToolLifecycleHooks : {}),
      ...(this.modules.some((module) => module.tools?.ended) ? {
        ended: (outcome) => this.observe("tools.ended", (module) => module.tools?.ended, [outcome]),
      } satisfies ToolLifecycleHooks : {}),
    } satisfies ToolLifecycleHooks);
    this.modelLifecycle = Object.freeze({
      ...(this.modules.some((module) => module.model?.started) ? {
        started: (context) => this.observe("model.started", (module) => module.model?.started, [context]),
      } satisfies ModelLifecycleHooks : {}),
      ...(this.modules.some((module) => module.model?.event) ? {
        event: (context, event) => this.observe("model.event", (module) => module.model?.event, [context, event]),
      } satisfies ModelLifecycleHooks : {}),
      ...(this.modules.some((module) => module.model?.ended) ? {
        ended: (outcome) => this.observe("model.ended", (module) => module.model?.ended, [outcome]),
      } satisfies ModelLifecycleHooks : {}),
    } satisfies ModelLifecycleHooks);
    this.agentLifecycle = Object.freeze({
      ...(this.modules.some((module) => module.agent?.started) ? {
        started: (context) => this.observe("agent.started", (module) => module.agent?.started, [context]),
      } satisfies AgentLifecycleHooks : {}),
      ...(this.modules.some((module) => module.agent?.ended) ? {
        ended: (outcome) => this.observe("agent.ended", (module) => module.agent?.ended, [outcome]),
      } satisfies AgentLifecycleHooks : {}),
    } satisfies AgentLifecycleHooks);
  }

  diagnose(diagnostic: HostHookDiagnostic): void {
    this.report(diagnostic.moduleId, diagnostic.point, diagnostic.error);
  }

  hasReview(moduleId: string): boolean {
    return this.modules.some((module) => module.id === moduleId && !!module.tools?.review);
  }

  async collectPrompt(context: HostPromptContext, signal?: AbortSignal): Promise<PromptFragment[]> {
    this.lifecycle.signal.throwIfAborted();
    signal?.throwIfAborted();
    const captured = copyData(context, true);
    const fragments: PromptFragment[] = [];
    const contributors = new Map<string, string>();
    for (const module of this.modules) {
      if (!module.prompt) continue;
      const contributed = await this.runAwaited(module, "prompt.collect", async (hookSignal) => {
        const result = await module.prompt!.collect(captured, hookSignal);
        if (!Array.isArray(result)) throw new TypeError("Prompt collector must return an array of fragments.");
        const copied = copyData(result, false);
        for (const fragment of copied) {
          if (!fragment || typeof fragment.id !== "string" || !fragment.id) throw new TypeError("Prompt fragments require a nonempty id.");
          const previous = contributors.get(fragment.id);
          if (previous) throw new Error(`Prompt fragment "${fragment.id}" is already contributed by module "${previous}".`);
        }
        return copied;
      }, signal);
      for (const fragment of contributed) contributors.set(fragment.id, module.id);
      fragments.push(...contributed);
    }
    return fragments;
  }

  async review(request: ToolReviewRequest, signal?: AbortSignal): Promise<ToolReviewResult> {
    this.lifecycle.signal.throwIfAborted();
    const captured = copyData(request, true);
    const permits: Array<{ module: HostModule; permit: ToolReviewResult }> = [];
    for (const module of this.modules) {
      if (!module.tools?.review) continue;
      const permit = await this.runAwaited(module, "tools.review", async (hookSignal) => {
        const value = await module.tools!.review!(captured, hookSignal);
        if (!value || (value.decision !== "allow" && value.decision !== "deny")
          || (value.reason !== undefined && typeof value.reason !== "string")
          || (value.assertCurrent !== undefined && typeof value.assertCurrent !== "function")) {
          throw new TypeError("Review must return allow or deny with an optional reason and freshness assertion.");
        }
        return Object.freeze({ ...value });
      }, signal);
      if (permit.decision === "deny") return permit;
      permits.push({ module, permit });
    }
    if (!permits.length) throw new Error("Automatic review requires a registered review module.");
    return { decision: "allow", reason: permits.map(({ permit }) => permit.reason).filter(Boolean).join("\n"),
      assertCurrent: async () => {
        this.lifecycle.signal.throwIfAborted();
        signal?.throwIfAborted();
        for (const { module, permit } of permits) {
          if (permit.assertCurrent) await this.runAwaited(module, "tools.review", () => permit.assertCurrent!(), signal);
        }
      } };
  }

  /** A committed setting update must finish even when its event listener starts shutdown. */
  async modelChanged(input: RuntimeModelChangedInput): Promise<void> {
    const captured = copyData(input, true);
    for (const module of this.modules) {
      if (module.modelSelection) await this.runAwaited(module, "modelSelection.changed",
        (signal) => module.modelSelection!.changed(captured, signal), undefined, true);
    }
  }

  observeRuntime(event: RuntimeEvent): void {
    this.observe("runtime.event", (module) => !module.runtime?.eventTypes || module.runtime.eventTypes.includes(event.type)
      ? module.runtime?.event : undefined, [event]);
  }

  /** Abort cancellable stages; completion observers remain live until their owners settle. */
  abortPending(): void {
    if (!this.lifecycle.signal.aborted) this.lifecycle.abort(new DOMException("Host modules are closing.", "AbortError"));
  }

  close(): void { this.closed = true; this.abortPending(); }

  private observe<Args extends unknown[]>(point: HostHookPoint,
    select: (module: HostModule) => ((...args: Args) => void) | undefined, args: Args): void {
    if (this.closed) return;
    let captured: Args | undefined;
    for (const module of this.modules) {
      if (this.closed) break;
      const handler = select(module);
      const key = `${module.id}:${point}`;
      if (!handler || this.disabledObservers.has(key)) continue;
      try {
        captured ??= copyData(args, true);
        const result: unknown = handler(...captured);
        if (isThenable(result)) {
          void Promise.resolve(result).catch(() => undefined);
          throw new TypeError("Lifecycle observers must be synchronous; Promise results are unsupported.");
        }
      } catch (cause) {
        this.disabledObservers.add(key);
        this.report(module.id, point, new HostHookError(module.id, point, cause));
      }
    }
  }

  private async runAwaited<T>(module: HostModule, point: HostHookPoint,
    operation: (signal: AbortSignal) => T | Promise<T>, signal?: AbortSignal, completion = false): Promise<T> {
    if (!completion) this.lifecycle.signal.throwIfAborted();
    const timeout = new AbortController();
    const combined = AbortSignal.any([timeout.signal, ...(!completion ? [this.lifecycle.signal] : []), ...(signal ? [signal] : [])]);
    const timeoutMs = module.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => timeout.abort(new Error(`Timed out after ${timeoutMs} ms.`)), timeoutMs);
    try {
      const result = await waitForSignal(() => operation(combined), combined);
      combined.throwIfAborted();
      return result;
    } catch (cause) {
      if (combined.aborted && !timeout.signal.aborted) throw combined.reason;
      const error = new HostHookError(module.id, point, cause);
      this.report(module.id, point, error);
      throw error;
    } finally { clearTimeout(timer); }
  }

  private report(moduleId: string, point: HostHookPoint, error: Error): void {
    if (this.reporting) return;
    this.reporting = true;
    try {
      const diagnosticError = new Error(error.message);
      diagnosticError.name = error.name;
      if (error.stack !== undefined) diagnosticError.stack = error.stack;
      const result: unknown = this.onError?.(Object.freeze({ moduleId, point, error: Object.freeze(diagnosticError) }));
      if (isThenable(result)) void Promise.resolve(result).catch(() => undefined);
    } catch { /* Diagnostics cannot change outcomes or recurse. */ }
    finally { this.reporting = false; }
  }
}

function captureModule(module: HostModule, builtin: boolean, ids: Set<string>): HostModule {
  if (!module || typeof module.id !== "string" || !module.id.trim() || module.id !== module.id.trim()) throw new TypeError("Module id must be a nonempty trimmed string.");
  if (!builtin && module.id.startsWith("chili.")) throw new TypeError(`Module id "${module.id}" uses the reserved chili. prefix.`);
  if (ids.has(module.id)) throw new TypeError(`Duplicate module id "${module.id}".`);
  if (module.timeoutMs !== undefined && (!Number.isSafeInteger(module.timeoutMs) || module.timeoutMs <= 0 || module.timeoutMs > MAX_TIMEOUT_MS)) {
    throw new TypeError(`Module "${module.id}" timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}.`);
  }
  const captured: Record<string, unknown> = { id: module.id, ...(module.timeoutMs === undefined ? {} : { timeoutMs: module.timeoutMs }) };
  let count = 0;
  for (const key of Object.keys(module)) {
    if (key !== "id" && key !== "timeoutMs" && !(key in CAPABILITIES)) throw new TypeError(`Unsupported module capability "${key}".`);
  }
  for (const group of Object.keys(CAPABILITIES) as Array<keyof typeof CAPABILITIES>) {
    const original = module[group];
    if (original === undefined) continue;
    if (!original || typeof original !== "object") throw new TypeError(`Invalid ${group} capability.`);
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(original)) {
      if (group === "runtime" && key === "eventTypes") continue;
      if (!(CAPABILITIES[group] as readonly string[]).includes(key)) throw new TypeError(`Unsupported module hook "${group}.${key}".`);
      const handler = (original as unknown as Record<string, unknown>)[key];
      if (typeof handler !== "function") throw new TypeError(`Module hook "${group}.${key}" requires a handler.`);
      copy[key] = handler.bind(original);
      count++;
    }
    if (group === "runtime" && module.runtime?.eventTypes !== undefined) {
      if (!Array.isArray(module.runtime.eventTypes) || module.runtime.eventTypes.some((type) => typeof type !== "string")) throw new TypeError("eventTypes must be an array of event types.");
      copy.eventTypes = Object.freeze([...module.runtime.eventTypes]);
    }
    captured[group] = Object.freeze(copy);
  }
  if (!count) throw new TypeError(`Module "${module.id}" must declare at least one hook.`);
  ids.add(module.id);
  return Object.freeze(captured) as unknown as HostModule;
}

function waitForSignal<T>(operation: () => T | Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { signal.removeEventListener("abort", aborted); reject(signal.reason ?? new DOMException("Hook aborted.", "AbortError")); };
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    else Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); })
      .then((value) => { signal.removeEventListener("abort", aborted); resolve(value); },
        (error: unknown) => { signal.removeEventListener("abort", aborted); reject(error); });
  });
}
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === "object" && value !== null || typeof value === "function") && typeof (value as { then?: unknown }).then === "function";
}
function errorMessage(error: unknown): string {
  try { return error instanceof Error ? error.message : String(error); } catch { return "Unknown hook failure"; }
}

/** No store/provider-owned values are passed to modules. Errors become frozen error data. */
function copyData<T>(value: T, freeze: boolean, ancestors = new Set<object>()): T {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === undefined) return value;
  if (typeof value !== "object") throw new TypeError("Host hook data must contain only plain data.");
  if (ancestors.has(value)) throw new TypeError("Host hook data cannot contain cycles.");
  const prototype = Object.getPrototypeOf(value);
  if (!(value instanceof Error) && !Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new TypeError("Host hook data must contain only plain objects, errors and arrays.");
  ancestors.add(value);
  try {
    const copy: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
    if (value instanceof Error) Object.assign(copy, { name: value.name, message: value.message, stack: value.stack });
    for (const key of Object.keys(value)) {
      const property = Object.getOwnPropertyDescriptor(value, key)!;
      if (!("value" in property)) throw new TypeError("Host hook data cannot contain accessors.");
      Object.defineProperty(copy, key, { value: copyData(property.value, freeze, ancestors), enumerable: true, configurable: true, writable: true });
    }
    return (freeze ? Object.freeze(copy) : copy) as T;
  } finally { ancestors.delete(value); }
}
