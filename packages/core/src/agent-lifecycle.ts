import type { SessionId, TimestampMs } from "@chili/protocol";

/** One accepted prompt execution, including all of its model/tool continuations. */
export interface AgentRunContext {
  readonly runId: string;
  readonly executionRef: string;
  readonly inputId?: string;
  readonly sessionId: SessionId;
  readonly agentRole: "root" | "child";
  readonly cwd: string;
  readonly startedAt: TimestampMs;
}

export interface AgentRunOutcome extends AgentRunContext {
  readonly endedAt: TimestampMs;
  readonly status: "completed" | "failed" | "cancelled" | "max_turns";
  readonly turnCount: number;
  readonly error?: string;
}

export interface AgentLifecycleHooks {
  /** Synchronous observation only; exceptions cannot veto an admitted run. */
  started?(context: AgentRunContext): void;
  /** Emitted after runtime settlement and lease release, before shutdown can finish. */
  ended?(outcome: AgentRunOutcome): void;
}

/** Isolate diagnostics from the runtime, including accidental async observers. */
export function observeAgentLifecycle<T extends AgentRunContext>(observer: ((value: T) => void) | undefined, value: T): void {
  if (!observer) return;
  try {
    const result: unknown = observer(Object.freeze({ ...value }));
    if (result !== null && (typeof result === "object" || typeof result === "function")
      && typeof (result as { then?: unknown }).then === "function") {
      void Promise.resolve(result).catch(() => undefined);
    }
  } catch {
    // Observers never change execution, settlement, or cleanup outcomes.
  }
}
