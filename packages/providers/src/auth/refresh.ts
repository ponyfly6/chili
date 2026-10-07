import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { FileAuthStorage, sameOAuthCredential, type OAuthCredential, type OAuthCredentials } from "./storage.js";

export const DEFAULT_OAUTH_REFRESH_TIMEOUT_MS = 30_000;

interface RefreshFlight {
  controller: AbortController;
  promise: Promise<OAuthCredential>;
  consumers: number;
}

const refreshFlights = new Map<string, RefreshFlight>();

/** Shared within a process; the storage claim coordinates different processes. */
export async function resolveOAuthCredentials(input: {
  storage: FileAuthStorage;
  provider: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  refreshSkewMs?: number;
  refresh: (stored: OAuthCredential, signal: AbortSignal) => Promise<OAuthCredentials>;
}): Promise<OAuthCredential> {
  const timeoutMs = validTimeout(input.timeoutMs);
  const deadline = requestDeadline(input.signal, timeoutMs);
  try {
    const expected = await raceWithSignal(input.storage.getOAuthCredentials(input.provider), deadline.signal);
    if (!expected) throw new Error(`No ${input.provider} OAuth credentials found; sign in before using this provider.`);
    const skew = input.refreshSkewMs ?? 60_000;
    if (expected.expires > Date.now() + skew) return expected;
    const key = createHash("sha256").update(JSON.stringify([
      resolve(input.storage.authPath), input.provider, expected,
    ])).digest("hex");
    let flight = refreshFlights.get(key);
    if (!flight || flight.controller.signal.aborted) {
      const controller = new AbortController();
      const created: RefreshFlight = { controller, consumers: 0, promise: undefined as unknown as Promise<OAuthCredential> };
      created.promise = refreshWithClaim(input, expected, controller.signal, timeoutMs, skew).finally(() => {
        if (refreshFlights.get(key) === created) refreshFlights.delete(key);
      });
      refreshFlights.set(key, created);
      flight = created;
    }
    flight.consumers++;
    try {
      const refreshed = await raceWithSignal(flight.promise, deadline.signal);
      // Logout/account selection can change while a consumer is waiting for its shared result.
      const current = await raceWithSignal(input.storage.getOAuthCredentials(input.provider), deadline.signal);
      if (!current || !sameOAuthCredential(current, refreshed)) throw credentialsChanged();
      return current;
    } finally {
      flight.consumers--;
      if (flight.consumers === 0) flight.controller.abort(abortError("OAuth refresh has no active consumers"));
    }
  } catch (error) {
    throw nonRetryableOAuthError(error);
  } finally {
    deadline.dispose();
  }
}

/** Token rotation can have happened remotely even when no model output exists. */
export function nonRetryableOAuthError(error: unknown): Error {
  const value = error instanceof Error ? error : new Error("OAuth credential resolution failed");
  try {
    Object.defineProperty(value, "retryable", { value: false, enumerable: true, configurable: true });
    return value;
  } catch {
    return Object.assign(new Error("OAuth credential resolution failed", { cause: value }), { name: value.name, retryable: false });
  }
}

async function refreshWithClaim(
  input: Parameters<typeof resolveOAuthCredentials>[0],
  expected: OAuthCredential,
  signal: AbortSignal,
  timeoutMs: number,
  skew: number,
): Promise<OAuthCredential> {
  const deadline = requestDeadline(signal, timeoutMs);
  const owner = randomUUID();
  const expiresAt = Date.now() + timeoutMs;
  let claimed = false;
  try {
    while (!claimed) {
      deadline.signal.throwIfAborted();
      const result = await input.storage.claimOAuthRefresh(input.provider, expected, owner, expiresAt, deadline.signal);
      if (result === "changed") {
        const current = await input.storage.getOAuthCredentials(input.provider);
        if (current?.accountId === expected.accountId && current.expires > Date.now() + skew) return current;
        throw credentialsChanged();
      }
      claimed = result === "claimed";
      if (!claimed) await abortableDelay(25, deadline.signal);
    }
    const refreshed = await raceWithSignal(input.refresh(expected, deadline.signal), deadline.signal);
    deadline.signal.throwIfAborted();
    if (refreshed.accountId !== expected.accountId) throw new Error("OAuth refresh returned a different account; sign in again to switch accounts");
    const committed = await input.storage.commitOAuthRefresh(input.provider, expected, refreshed, owner, deadline.signal);
    if (!committed) throw credentialsChanged();
    const current = await input.storage.getOAuthCredentials(input.provider);
    if (!current || current.accountId !== refreshed.accountId || current.access !== refreshed.access) throw credentialsChanged();
    return current;
  } finally {
    deadline.dispose();
    if (claimed) await input.storage.releaseOAuthRefresh(input.provider, owner);
  }
}

export function requestDeadline(signal: AbortSignal | undefined, timeoutMs: number = DEFAULT_OAUTH_REFRESH_TIMEOUT_MS): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Provider request deadline exceeded", "TimeoutError")), validTimeout(timeoutMs));
  const onAbort = (): void => controller.abort(signal?.reason ?? abortError());
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  return { signal: controller.signal, dispose: () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    controller.abort(abortError("Provider request finished"));
  } };
}

export function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const onAbort = (): void => reject(signal.reason ?? abortError());
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolvePromise, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolvePromise(); }, ms);
    const onAbort = (): void => { clearTimeout(timer); reject(signal.reason ?? abortError()); };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

function validTimeout(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : DEFAULT_OAUTH_REFRESH_TIMEOUT_MS;
}

function credentialsChanged(): Error { return new Error("OAuth credentials changed during refresh; the stale request was cancelled"); }
function abortError(message = "Provider request aborted"): Error { return new DOMException(message, "AbortError"); }
