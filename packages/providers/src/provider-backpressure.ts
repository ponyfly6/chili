import { createHash } from "node:crypto";
import { ProviderError, isProviderError } from "./provider-error.js";

export interface ProviderRequestScope {
  provider: string;
  endpoint?: string;
  /** When present, partitions process-local state; the coordinator stores only its SHA-256 fingerprint. */
  credential?: string;
}

export interface ProviderBackpressureCoordinatorOptions {
  circuitOpenMs?: number;
  rateLimitBackoffMs?: number;
  now?: () => number;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface ProviderBackpressureSnapshot {
  mode: "circuit_open" | "rate_limited";
  blockedUntil: number;
  error: ProviderError;
}

type ProviderBackpressureState = ProviderBackpressureSnapshot;

const DEFAULT_CIRCUIT_OPEN_MS = 30_000;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 500;

export class ProviderBackpressureCoordinator {
  private readonly states = new Map<string, ProviderBackpressureState>();
  private readonly circuitOpenMs: number;
  private readonly rateLimitBackoffMs: number;
  private readonly now: () => number;
  private readonly waitImpl: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: ProviderBackpressureCoordinatorOptions = {}) {
    this.circuitOpenMs = finiteDelay(options.circuitOpenMs, DEFAULT_CIRCUIT_OPEN_MS);
    this.rateLimitBackoffMs = finiteDelay(options.rateLimitBackoffMs, DEFAULT_RATE_LIMIT_BACKOFF_MS);
    this.now = options.now ?? Date.now;
    this.waitImpl = options.wait ?? abortableWait;
  }

  async beforeRequest(scope: ProviderRequestScope, signal?: AbortSignal): Promise<void> {
    const key = scopeKey(scope);
    while (true) {
      const state = this.activeState(key);
      if (!state) return;
      if (state.mode === "circuit_open") throw cloneCircuitError(state.error);

      const delayMs = Math.max(0, state.blockedUntil - this.now());
      if (delayMs > 0) await this.waitImpl(delayMs, signal);
      if (this.states.get(key) === state && state.blockedUntil <= this.now()) this.states.delete(key);
    }
  }

  recordError(scope: ProviderRequestScope, error: unknown): void {
    if (!isProviderError(error)) return;
    const key = scopeKey(scope);
    const now = this.now();
    if (error.opensCircuit) {
      this.states.set(key, {
        mode: "circuit_open",
        blockedUntil: now + this.circuitOpenMs,
        error,
      });
      return;
    }
    if (!error.retryable || error.category !== "rate_limit") return;

    const delayMs = finiteDelay(error.retryAfterMs, this.rateLimitBackoffMs);
    const next: ProviderBackpressureState = {
      mode: "rate_limited",
      blockedUntil: now + delayMs,
      error,
    };
    const current = this.activeState(key);
    if (current?.mode === "circuit_open") return;
    if (!current || next.blockedUntil > current.blockedUntil) this.states.set(key, next);
  }

  snapshot(scope: ProviderRequestScope): ProviderBackpressureSnapshot | undefined {
    const state = this.activeState(scopeKey(scope));
    return state ? { ...state } : undefined;
  }

  clear(scope?: ProviderRequestScope): void {
    if (scope) this.states.delete(scopeKey(scope));
    else this.states.clear();
  }

  private activeState(key: string): ProviderBackpressureState | undefined {
    const state = this.states.get(key);
    if (!state) return undefined;
    if (state.blockedUntil > this.now()) return state;
    this.states.delete(key);
    return undefined;
  }
}

export const sharedProviderBackpressureCoordinator = new ProviderBackpressureCoordinator();

function scopeKey(scope: ProviderRequestScope): string {
  return [
    scope.provider.trim().toLowerCase(),
    normalizedEndpoint(scope.endpoint),
    credentialFingerprint(scope.credential),
  ].join("\u0000");
}

function credentialFingerprint(credential: string | undefined): string {
  if (!credential) return "";
  return createHash("sha256").update(credential, "utf8").digest("hex");
}

function normalizedEndpoint(value: string | undefined): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return value.replace(/\/+$/, "");
  }
}

function cloneCircuitError(error: ProviderError): ProviderError {
  return new ProviderError(error.message, {
    provider: error.provider,
    category: error.category,
    retryable: false,
    opensCircuit: true,
    ...(error.status !== undefined ? { status: error.status } : {}),
    ...(error.code !== undefined ? { code: error.code } : {}),
    ...(error.type !== undefined ? { type: error.type } : {}),
    ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
    ...(error.details !== undefined ? { details: error.details } : {}),
    cause: error,
  });
}

function finiteDelay(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : fallback;
}

async function abortableWait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error("Provider backpressure wait aborted");
  error.name = "AbortError";
  return error;
}
