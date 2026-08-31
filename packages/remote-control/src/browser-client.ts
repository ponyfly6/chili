import {
  BrowserReplayGuard,
  browserRandomIdentifier,
  createBrowserPairingProof,
  generateBrowserDeviceIdentity,
  openBrowserRelayEnvelope,
  requireSecureBrowserCrypto,
  sealBrowserRelayEnvelope,
  validateBrowserPairingChallenge,
  validateBrowserPairingGrant,
} from "./browser-security.js";
import { MAX_HTTP_RESPONSE_BYTES, decodeWireEnvelope, encodeWireEnvelope } from "./http-wire.js";
import {
  REMOTE_CONTROL_LIMITS,
  parseRemoteControlFrame,
  requiredCapabilityForOperation,
  type RemoteControlFrame,
  type RemoteControlJsonValue,
  type RemoteControlOperation,
  type RemoteControlOperationPayloadMap,
  type RemoteControlRequestFrame,
} from "./protocol.js";
import type { PairingGrant } from "./pairing-security.js";

export type BrowserControlState = "connected" | "disconnected" | "reconnecting" | "expired" | "closed";
export type BrowserPairingStatus = "creating_identity" | "waiting_for_desktop" | "approved";

export class BrowserControlClientError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BrowserControlClientError";
  }
}

export interface BrowserPairOptions {
  baseUrl?: string;
  pairingCode: string;
  deviceLabel?: string;
  onPairingStatus?: (status: BrowserPairingStatus) => void;
  signal?: AbortSignal;
}

export interface BrowserControlClientOptions {
  baseUrl: string;
  pairing: PairingGrant;
  /** Bounded requests retain their sequence after timeout until explicit resync. */
  requestTimeoutMs?: number;
  pollIntervalMs?: number;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface PendingRequest {
  frame: RemoteControlRequestFrame;
  admitted: boolean;
  result: Deferred<RemoteControlJsonValue>;
  admission: Deferred<void>;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Production HTTPS client. All identity, credential, sequence and replay state
 * share this page lifetime; reconnect retains all of them, refresh retains none.
 * Admission is ordered, execution/results are concurrent so Stop does not wait
 * for a slow snapshot. The only retry is an explicit same-sequence resync probe.
 */
export class BrowserControlClient {
  readonly #baseUrl: string;
  readonly #pairing: PairingGrant;
  readonly #sessionId = browserRandomIdentifier("session");
  readonly #requestTimeoutMs: number;
  readonly #pollIntervalMs: number;
  readonly #listeners = new Set<(state: BrowserControlState) => void>();
  readonly #pending = new Map<number, PendingRequest>();
  #state: BrowserControlState = "connected";
  #nextSequence = 1;
  #acknowledgedSequence = 0;
  #replay = new BrowserReplayGuard();
  #admissionTail: Promise<void> = Promise.resolve();
  #queuedCount = 0;
  #pollTimer: ReturnType<typeof setTimeout> | undefined;
  #polling = false;
  #reconnectPromise: Promise<void> | undefined;
  #synchronized: Deferred<void> | undefined;
  #synchronizingSequence: number | undefined;

  static async pair(options: BrowserPairOptions): Promise<BrowserControlClient> {
    const baseUrl = secureBaseUrl(options.baseUrl);
    requireSecureBrowserCrypto();
    options.onPairingStatus?.("creating_identity");
    const identity = await generateBrowserDeviceIdentity();
    const begin = await postJson(baseUrl, "/api/pairing/begin", {
      pairingCode: options.pairingCode.trim(),
      deviceId: identity.deviceId,
      publicKey: identity.publicKey,
      ...(options.deviceLabel ? { label: options.deviceLabel.slice(0, 48) } : {}),
    }, undefined, options.signal);
    const challenge = validateBrowserPairingChallenge(begin.challenge, identity);
    if (typeof begin.pairingId !== "string" || typeof begin.pairingToken !== "string") {
      throw new BrowserControlClientError("INVALID_PAIRING_RESPONSE");
    }
    const pairingHandle = { pairingId: begin.pairingId, pairingToken: begin.pairingToken };
    await postJson(baseUrl, "/api/pairing/prove", {
      ...pairingHandle,
      proof: await createBrowserPairingProof(challenge, identity),
    }, undefined, options.signal);
    options.onPairingStatus?.("waiting_for_desktop");
    while (Date.now() < challenge.expiresAt) {
      const status = await postJson(baseUrl, "/api/pairing/poll", pairingHandle, undefined, options.signal);
      if (status.status === "approved") {
        const pairing = validateBrowserPairingGrant(status.grant, challenge);
        options.onPairingStatus?.("approved");
        return new BrowserControlClient({ baseUrl, pairing });
      }
      if (status.status !== "pending_confirmation") throw new BrowserControlClientError("INVALID_PAIRING_RESPONSE");
      await delay(1_000, options.signal);
    }
    throw new BrowserControlClientError("pairing_expired");
  }

  constructor(options: BrowserControlClientOptions) {
    this.#baseUrl = secureBaseUrl(options.baseUrl);
    requireSecureBrowserCrypto();
    this.#pairing = Object.freeze({ ...options.pairing, capabilities: Object.freeze([...options.pairing.capabilities]), channel: Object.freeze({ ...options.pairing.channel }) });
    this.#requestTimeoutMs = boundedInteger(options.requestTimeoutMs ?? 15_000, 100, 60_000);
    this.#pollIntervalMs = boundedInteger(options.pollIntervalMs ?? 250, 20, 5_000);
    this.#schedulePoll(0);
  }

  get state(): BrowserControlState { return this.#state; }

  onState(listener: (state: BrowserControlState) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  request<Operation extends RemoteControlOperation>(operation: Operation, payload: RemoteControlOperationPayloadMap[Operation]): Promise<RemoteControlJsonValue> {
    if (this.#state !== "connected") return Promise.reject(new BrowserControlClientError(this.#state === "expired" ? "PAIRING_REQUIRED" : "NOT_CONNECTED"));
    if (this.#queuedCount + this.#pending.size >= REMOTE_CONTROL_LIMITS.maxQueueMessages) {
      return Promise.reject(new BrowserControlClientError("REQUEST_LIMIT_EXCEEDED"));
    }
    if (!this.#pairing.capabilities.includes(requiredCapabilityForOperation(operation))) {
      return Promise.reject(new BrowserControlClientError("CAPABILITY_NOT_GRANTED"));
    }
    const result = deferred<RemoteControlJsonValue>();
    this.#queuedCount += 1;
    const admission = this.#admissionTail.then(async () => {
      this.#queuedCount -= 1;
      if (this.#state !== "connected" && this.#state !== "reconnecting") throw new BrowserControlClientError("NOT_CONNECTED");
      if (this.#nextSequence > REMOTE_CONTROL_LIMITS.maxSequence) throw new BrowserControlClientError("SEQUENCE_EXHAUSTED");
      const parsed = parseRemoteControlFrame({
        version: 1,
        type: "request",
        hostId: this.#pairing.hostId,
        sessionId: this.#sessionId,
        deviceId: this.#pairing.deviceId,
        credential: this.#pairing.credential,
        sequence: this.#nextSequence,
        requestId: browserRandomIdentifier("request"),
        operation,
        capability: requiredCapabilityForOperation(operation),
        payload,
      });
      if (parsed.type !== "request") throw new BrowserControlClientError("INVALID_REQUEST");
      // Crypto/validation failure before transmission does not consume a sequence.
      const envelope = await sealBrowserRelayEnvelope(this.#pairing.channel, "device_to_host", parsed);
      if (this.#state !== "connected" && this.#state !== "reconnecting") throw new BrowserControlClientError("NOT_CONNECTED");
      const pending: PendingRequest = {
        frame: parsed,
        admitted: false,
        admission: deferred<void>(),
        result,
        timer: setTimeout(() => {
          if (this.#pending.get(parsed.sequence) !== pending) return;
          result.reject(new BrowserControlClientError("outcome_unknown"));
          this.#setState("disconnected");
        }, this.#requestTimeoutMs),
      };
      this.#pending.set(parsed.sequence, pending);
      this.#nextSequence += 1;
      // Poll-delivered admission is sufficient to release the next operation,
      // even if the HTTP 202 response itself is delayed or lost in transit.
      void this.#post("/api/control/send", { ...this.#routeIdentity(), envelope: encodeWireEnvelope(envelope) }).catch((error: unknown) => {
        if (this.#pending.get(parsed.sequence) !== pending || pending.admitted) return;
        // A failed HTTP response cannot prove non-execution. Retain exact frame.
        this.#transportFailed(error);
        result.reject(new BrowserControlClientError("outcome_unknown"));
      });
      await pending.admission.promise;
    });
    this.#admissionTail = admission.catch((error: unknown) => { result.reject(error); });
    return result.promise;
  }

  disconnect(): void {
    if (this.#state !== "expired" && this.#state !== "closed") this.#setState("disconnected");
  }

  reconnect(): Promise<void> {
    if (this.#reconnectPromise) return this.#reconnectPromise;
    if (this.#state === "closed" || this.#state === "expired") return Promise.reject(new BrowserControlClientError("PAIRING_REQUIRED"));
    const promise = this.#performReconnect();
    this.#reconnectPromise = promise;
    void promise.finally(() => { this.#reconnectPromise = undefined; }).catch(() => {});
    return promise;
  }

  dispose(): void {
    this.#setState("closed");
    this.#failPending("CLIENT_CLOSED");
    this.#listeners.clear();
  }

  async #performReconnect(): Promise<void> {
    this.#setState("reconnecting");
    this.#replay = new BrowserReplayGuard();
    this.#schedulePoll(0);
    // An older admitted read can still await a result while a later command
    // lacks admission. Recover that command first so it cannot strand the
    // admission queue behind an unrelated lost read result.
    const earliest = [...this.#pending.values()].find((pending) => !pending.admitted)
      ?? this.#pending.values().next().value as PendingRequest | undefined;
    if (earliest) {
      const sync = deferred<void>();
      // Poll/revocation can reject this internal waiter while encryption or the
      // send HTTP request is still awaited. Observe it immediately, including
      // when send itself fails and never reaches `await sync.promise` below.
      // The original promise remains rejected so its public reconnect caller
      // still receives the authentication/timeout error through the await.
      void sync.promise.catch(() => {});
      this.#synchronized = sync;
      this.#synchronizingSequence = earliest.frame.sequence;
      const timeout = setTimeout(() => sync.reject(new BrowserControlClientError("RECONNECT_TIMEOUT")), this.#requestTimeoutMs);
      try {
        // Same request id + sequence, fresh authenticated envelope, exactly once
        // per explicit reconnect. Never retry as a new queue command.
        const envelope = await sealBrowserRelayEnvelope(this.#pairing.channel, "device_to_host", earliest.frame);
        await this.#post("/api/control/send", { ...this.#routeIdentity(), envelope: encodeWireEnvelope(envelope) });
        await sync.promise;
      } catch (error) {
        this.#transportFailed(error);
        throw error;
      } finally {
        clearTimeout(timeout);
        this.#synchronized = undefined;
        this.#synchronizingSequence = undefined;
      }
    } else {
      // Authentication on an empty poll verifies reconnect/revocation too.
      try { await this.#pollOnce(); }
      catch (error) { this.#transportFailed(error); throw error; }
    }
    if (this.#state === "reconnecting") this.#setState("connected");
    this.#schedulePoll(0);
  }

  #routeIdentity(): { deviceId: string; routeId: string } {
    return { deviceId: this.#pairing.deviceId, routeId: this.#pairing.channel.routeId };
  }

  #post(path: string, body: unknown): Promise<Record<string, unknown>> {
    return postJson(this.#baseUrl, path, body, this.#pairing.credential);
  }

  #schedulePoll(wait: number): void {
    if (this.#pollTimer !== undefined) clearTimeout(this.#pollTimer);
    if (this.#state !== "connected" && this.#state !== "reconnecting") return;
    this.#pollTimer = setTimeout(() => {
      this.#pollTimer = undefined;
      void this.#pollOnce().catch((error: unknown) => this.#transportFailed(error)).finally(() => this.#schedulePoll(this.#pollIntervalMs));
    }, wait);
  }

  async #pollOnce(): Promise<void> {
    if (this.#polling) return;
    this.#polling = true;
    try {
      const result = await this.#post("/api/control/poll", this.#routeIdentity());
      if (!Array.isArray(result.envelopes) || result.envelopes.length > REMOTE_CONTROL_LIMITS.maxQueueMessages) {
        throw new BrowserControlClientError("INVALID_POLL_RESPONSE");
      }
      for (const wire of result.envelopes) {
        const inner = await openBrowserRelayEnvelope(this.#pairing.channel, decodeWireEnvelope(wire), this.#replay);
        this.#acceptFrame(parseRemoteControlFrame(inner));
      }
    } finally { this.#polling = false; }
  }

  #acceptFrame(frame: RemoteControlFrame): void {
    if (frame.hostId !== this.#pairing.hostId || frame.sessionId !== this.#sessionId || frame.type === "request") {
      throw new BrowserControlClientError("RESPONSE_CONTEXT_MISMATCH");
    }
    if (frame.type === "resync") {
      if (frame.acknowledgedSequence < this.#acknowledgedSequence || frame.acknowledgedSequence >= this.#nextSequence) {
        throw new BrowserControlClientError("INVALID_RESYNC");
      }
      for (let sequence = this.#acknowledgedSequence + 1; sequence <= frame.acknowledgedSequence; sequence += 1) {
        if (!this.#pending.has(sequence)) throw new BrowserControlClientError("RESYNC_HISTORY_MISSING");
      }
      this.#acknowledgedSequence = frame.acknowledgedSequence;
      for (const [sequence, pending] of this.#pending) {
        if (sequence <= frame.acknowledgedSequence) {
          this.#settle(pending, new BrowserControlClientError("outcome_unknown"));
        }
      }
      if (this.#synchronizingSequence !== undefined && frame.acknowledgedSequence >= this.#synchronizingSequence) {
        this.#synchronized?.resolve();
      }
      return;
    }
    const pending = this.#pending.get(frame.sequence);
    if (!pending) {
      // Authenticated late ACK/result after an outcome_unknown is evidence for
      // an already consumed sequence, never permission to submit it again.
      if (frame.sequence <= this.#acknowledgedSequence) return;
      throw new BrowserControlClientError("RESPONSE_NOT_PENDING");
    }
    if (pending.frame.requestId !== frame.requestId) throw new BrowserControlClientError("RESPONSE_CORRELATION_MISMATCH");
    if (frame.type === "ack") {
      if (frame.acknowledgedSequence !== frame.sequence) throw new BrowserControlClientError("INVALID_ACK");
      this.#admit(pending);
      this.#resolveSynchronization(frame.sequence);
    } else if (frame.type === "result") {
      // A correlated authenticated terminal result itself proves admission when
      // the separate ACK was lost. Higher out-of-order admissions remain illegal.
      this.#admit(pending);
      this.#settle(pending, undefined, frame.result);
      this.#resolveSynchronization(frame.sequence);
    } else if (frame.admitted) {
      this.#admit(pending);
      // Admission precedes runtime execution. A failed/oversized/timed-out
      // response cannot prove that a send or Stop had no side effect.
      const mutating = pending.frame.operation === "session.send" || pending.frame.operation === "session.stop";
      this.#settle(pending, new BrowserControlClientError(mutating ? "outcome_unknown" : frame.error.code));
      this.#resolveSynchronization(frame.sequence);
    } else if (pending.admitted || frame.sequence !== this.#acknowledgedSequence + 1) {
      throw new BrowserControlClientError("ERROR_ADMISSION_MISMATCH");
    } else if (frame.error.retryable) {
      pending.result.reject(new BrowserControlClientError(frame.error.code));
      this.#setState("disconnected");
      this.#synchronized?.reject(new BrowserControlClientError(frame.error.code));
    } else {
      // This authenticated, correlated admitted:false response proves that
      // this exact attempt did not execute. Settle it before terminating the
      // stream; older transmitted mutations may still have unknown outcomes.
      this.#settle(pending, new BrowserControlClientError(frame.error.code));
      this.#setState("expired");
      this.#failPending(frame.error.code);
    }
  }

  #admit(pending: PendingRequest): void {
    if (pending.admitted) return;
    if (pending.frame.sequence !== this.#acknowledgedSequence + 1) throw new BrowserControlClientError("ACK_STALE_OR_FUTURE");
    pending.admitted = true;
    this.#acknowledgedSequence = pending.frame.sequence;
    pending.admission.resolve();
  }

  #resolveSynchronization(sequence: number): void {
    if (sequence === this.#synchronizingSequence) this.#synchronized?.resolve();
  }

  #settle(pending: PendingRequest, error?: Error, result?: RemoteControlJsonValue): void {
    clearTimeout(pending.timer);
    this.#pending.delete(pending.frame.sequence);
    pending.admission.resolve();
    if (error) pending.result.reject(error);
    else pending.result.resolve(result ?? null);
  }

  #transportFailed(error: unknown): void {
    if (this.#state === "closed" || this.#state === "expired") return;
    const code = error instanceof BrowserControlClientError ? error.code : "CONNECTION_LOST";
    if (["authentication_failed", "credential_expired", "credential_revoked", "remote_disabled", "PAIRING_REQUIRED"].includes(code)) {
      this.#setState("expired");
      this.#failPending(code);
    } else this.#setState("disconnected");
  }

  #failPending(code: string): void {
    // Entries enter #pending only when dispatching their encrypted HTTP send.
    // Losing the page or authorization cannot retract an already issued
    // mutation, even if its ACK was lost. Requests still waiting for admission
    // live outside this map and retain their ordinary never-sent rejection.
    for (const pending of this.#pending.values()) {
      const mutating = pending.frame.operation === "session.send" || pending.frame.operation === "session.stop";
      this.#settle(pending, new BrowserControlClientError(mutating ? "outcome_unknown" : code));
    }
    this.#synchronized?.reject(new BrowserControlClientError(code));
  }

  #setState(state: BrowserControlState): void {
    if (this.#state === state || this.#state === "closed") return;
    this.#state = state;
    if (this.#pollTimer !== undefined) clearTimeout(this.#pollTimer);
    this.#pollTimer = undefined;
    for (const listener of this.#listeners) {
      try { listener(state); } catch { /* UI observers cannot alter protocol state. */ }
    }
  }
}

function secureBaseUrl(value?: string): string {
  const url = new URL(value ?? (typeof location === "undefined" ? "https://invalid.invalid" : location.origin));
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new BrowserControlClientError("TRUSTED_HTTPS_REQUIRED");
  }
  if (typeof location !== "undefined" && url.origin !== location.origin) throw new BrowserControlClientError("SAME_ORIGIN_REQUIRED");
  return url.origin;
}

async function postJson(baseUrl: string, path: string, body: unknown, credential?: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const cancel = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", cancel, { once: true });
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(credential ? { Authorization: `Bearer ${credential}` } : {}) },
      body: JSON.stringify(body),
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    return await readJsonResponse(response);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
  }
}

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const advertisedBytes = Number(response.headers.get("content-length"));
  if (advertisedBytes > MAX_HTTP_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new BrowserControlClientError("RESPONSE_TOO_LARGE");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new BrowserControlClientError("INVALID_HTTP_RESPONSE");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > MAX_HTTP_RESPONSE_BYTES) {
      await reader.cancel();
      throw new BrowserControlClientError("RESPONSE_TOO_LARGE");
    }
    chunks.push(next.value);
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(combined)); }
  catch { throw new BrowserControlClientError("INVALID_HTTP_RESPONSE"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new BrowserControlClientError("INVALID_HTTP_RESPONSE");
  const result = parsed as Record<string, unknown>;
  if (!response.ok) {
    const error = result.error as { code?: unknown } | undefined;
    const code = typeof error?.code === "string" && /^[A-Za-z_]{1,64}$/.test(error.code) ? error.code : "HTTP_REQUEST_FAILED";
    throw new BrowserControlClientError(code);
  }
  return result;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function boundedInteger(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError("INVALID_CLIENT_LIMIT");
  return value;
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new BrowserControlClientError("PAIRING_CANCELLED");
  await new Promise<void>((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(new BrowserControlClientError("PAIRING_CANCELLED")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", cancel); resolve(); }, milliseconds);
    signal?.addEventListener("abort", cancel, { once: true });
  });
}
