import { randomBytes } from "node:crypto";

import {
  PairingSecurityError,
  RelayReplayGuard,
  openRelayEnvelope,
  sealRelayEnvelope,
  type DeviceIdentity,
  type PairingGrant,
} from "./pairing-security.js";
import {
  REMOTE_CONTROL_LIMITS,
  REMOTE_CONTROL_PROTOCOL_VERSION,
  parseOpaqueRelayEnvelope,
  parseRemoteControlFrame,
  requiredCapabilityForOperation,
  type OpaqueRelayEnvelope,
  type RemoteControlFrame,
  type RemoteControlHostId,
  type RemoteControlOperation,
  type RemoteControlOperationPayloadMap,
  type RemoteControlRequestFrame,
  type RemoteControlRequestId,
  type RemoteControlSessionId,
} from "./protocol.js";
import type {
  InMemoryRelay,
  RelayConnection,
  RelaySendResult,
} from "./in-memory-relay.js";

export type FakeMobileClientErrorCode =
  | "PAIRING_IDENTITY_MISMATCH"
  | "PAIRING_HOST_MISMATCH"
  | "CAPABILITY_NOT_GRANTED"
  | "SEQUENCE_EXHAUSTED"
  | "TRACKED_REQUEST_LIMIT_EXCEEDED"
  | "ADMISSION_PENDING"
  | "HOST_MISMATCH"
  | "SESSION_MISMATCH"
  | "UNEXPECTED_REQUEST_FRAME"
  | "RESPONSE_NOT_PENDING"
  | "RESPONSE_CORRELATION_MISMATCH"
  | "ACK_STALE_OR_FUTURE"
  | "RESULT_BEFORE_ACK"
  | "ERROR_STALE_OR_FUTURE"
  | "STREAM_TERMINATED"
  | "RESYNC_ACK_REGRESSION"
  | "RESYNC_FUTURE_ACK"
  | "RESYNC_HISTORY_MISSING";

/** Stable, value-free errors avoid reflecting credentials or plaintext. */
export class FakeMobileClientError extends Error {
  readonly code: FakeMobileClientErrorCode;

  constructor(code: FakeMobileClientErrorCode) {
    super(code);
    this.name = "FakeMobileClientError";
    this.code = code;
  }
}

export interface FakeMobileClientOptions {
  relay: InMemoryRelay;
  identity: DeviceIdentity;
  pairing: PairingGrant;
  /** Stable host identity expected inside authenticated frames. */
  hostId: string;
  /** A reconnectable protocol stream id; generated when omitted. */
  sessionId?: string;
  clock?: () => number;
  requestIdFactory?: () => string;
  messageIdFactory?: () => string;
  onFrame?: (frame: RemoteControlFrame) => void;
  maxTrackedRequests?: number;
  maxReceivedFrames?: number;
  maxInboundReplayEntries?: number;
  onOutcomeUnknown?: (outcome: FakeMobileOutcomeUnknown) => void;
}

export interface FakeMobileRequest<Operation extends RemoteControlOperation> {
  operation: Operation;
  payload: RemoteControlOperationPayloadMap[Operation];
}

export interface FakeMobileRequestReceipt {
  sequence: number;
  requestId: RemoteControlRequestId;
  status: RelaySendResult["status"] | "retained_offline";
}

/** A resync proved admission but cannot prove the lost service outcome. */
export interface FakeMobileOutcomeUnknown {
  type: "local_error";
  code: "outcome_unknown";
  reason: "resync_required";
  sequence: number;
  requestId: RemoteControlRequestId;
}

export interface FakeMobileClientSnapshot {
  connected: boolean;
  /** True means this credential-bound stream failed closed and cannot send again. */
  streamTerminated: boolean;
  nextSequence: number;
  acknowledgedSequence: number;
  unackedSequences: readonly number[];
  trackedRequests: number;
  receivedFrames: number;
  rejectedInbound: number;
  outboundFailures: number;
  replayEntries: number;
  outcomeUnknownSequences: readonly number[];
  lastInboundErrorCode?: string;
}

interface TrackedRequest {
  frame: RemoteControlRequestFrame;
  admitted: boolean;
  terminal: boolean;
  retryOnReconnect: boolean;
  relayStatus?: RelaySendResult["status"];
}

const DEFAULT_MAX_TRACKED_REQUESTS = REMOTE_CONTROL_LIMITS.maxQueueMessages;
const DEFAULT_MAX_RECEIVED_FRAMES = REMOTE_CONTROL_LIMITS.maxQueueMessages * 2;
const DEFAULT_MAX_INBOUND_REPLAY_ENTRIES = REMOTE_CONTROL_LIMITS.maxQueueMessages * 64;

/**
 * A host-neutral fake mobile endpoint used by the Phase 0 vertical slice.
 * Pairing secrets and complete protocol frames stay in this endpoint and in
 * authenticated ciphertext; the relay receives only an opaque envelope.
 */
export class FakeMobileClient {
  readonly hostId: RemoteControlHostId;
  readonly sessionId: RemoteControlSessionId;

  readonly #relay: InMemoryRelay;
  readonly #identity: Readonly<DeviceIdentity>;
  readonly #pairing: Readonly<PairingGrant>;
  readonly #clock: () => number;
  readonly #requestIdFactory: () => string;
  readonly #messageIdFactory: (() => string) | undefined;
  readonly #onFrame: ((frame: RemoteControlFrame) => void) | undefined;
  readonly #onOutcomeUnknown:
    | ((outcome: FakeMobileOutcomeUnknown) => void)
    | undefined;
  readonly #maxTrackedRequests: number;
  readonly #maxReceivedFrames: number;
  readonly #maxInboundReplayEntries: number;
  readonly #tracked = new Map<number, TrackedRequest>();
  readonly #received: RemoteControlFrame[] = [];
  readonly #outcomeUnknown: FakeMobileOutcomeUnknown[] = [];

  #connection: RelayConnection | undefined;
  #replayGuard: RelayReplayGuard;
  #nextSequence = 1;
  #acknowledgedSequence = 0;
  #streamTerminated = false;
  #rejectedInbound = 0;
  #outboundFailures = 0;
  #lastInboundErrorCode: string | undefined;

  constructor(options: FakeMobileClientOptions) {
    if (options.identity.deviceId !== options.pairing.deviceId) {
      throw new FakeMobileClientError("PAIRING_IDENTITY_MISMATCH");
    }
    if (
      options.pairing.hostId !== options.hostId ||
      options.pairing.channel.hostId !== options.hostId
    ) {
      throw new FakeMobileClientError("PAIRING_HOST_MISMATCH");
    }
    const context = parseRemoteControlFrame({
      version: REMOTE_CONTROL_PROTOCOL_VERSION,
      type: "resync",
      hostId: options.hostId,
      sessionId: options.sessionId ?? randomIdentifier("session"),
      acknowledgedSequence: 0,
      expectedSequence: 1,
      reason: "reconnect",
    });
    if (context.type !== "resync") {
      throw new FakeMobileClientError("SESSION_MISMATCH");
    }

    this.#relay = options.relay;
    this.#identity = Object.freeze({ ...options.identity });
    this.#pairing = Object.freeze({
      ...options.pairing,
      capabilities: Object.freeze([...options.pairing.capabilities]),
      channel: Object.freeze({ ...options.pairing.channel }),
    });
    this.hostId = context.hostId;
    this.sessionId = context.sessionId;
    this.#clock = options.clock ?? Date.now;
    this.#requestIdFactory =
      options.requestIdFactory ?? (() => randomIdentifier("request"));
    this.#messageIdFactory = options.messageIdFactory;
    this.#onFrame = options.onFrame;
    this.#onOutcomeUnknown = options.onOutcomeUnknown;
    this.#maxTrackedRequests = positiveInteger(
      options.maxTrackedRequests ?? DEFAULT_MAX_TRACKED_REQUESTS,
      "maxTrackedRequests",
    );
    this.#maxReceivedFrames = positiveInteger(
      options.maxReceivedFrames ?? DEFAULT_MAX_RECEIVED_FRAMES,
      "maxReceivedFrames",
    );
    this.#maxInboundReplayEntries = positiveInteger(
      options.maxInboundReplayEntries ?? DEFAULT_MAX_INBOUND_REPLAY_ENTRIES,
      "maxInboundReplayEntries",
    );
    this.#replayGuard = new RelayReplayGuard(this.#maxInboundReplayEntries);
  }

  get connected(): boolean {
    return this.#connection?.connected ?? false;
  }

  get deviceId(): string {
    return this.#identity.deviceId;
  }

  get nextSequence(): number {
    return this.#nextSequence;
  }

  get acknowledgedSequence(): number {
    return this.#acknowledgedSequence;
  }

  get unackedSequences(): readonly number[] {
    return Object.freeze(
      [...this.#tracked.entries()]
        .filter(([, request]) => !request.admitted && !request.terminal)
        .map(([sequence]) => sequence)
        .sort((left, right) => left - right),
    );
  }

  connect(): void {
    if (this.connected) {
      return;
    }
    // Message-id replay protection is connection-local. Credential-bound,
    // monotonic protocol sequences still reject old authenticated frames after
    // reconnect, while resetting avoids exhausting a permanent finite set.
    this.#replayGuard = new RelayReplayGuard(this.#maxInboundReplayEntries);
    this.#connection = this.#relay.connectDevice({
      routeId: this.#pairing.channel.routeId,
      onMessage: (envelope) => {
        this.acceptEnvelope(envelope);
      },
    });

    // A queued relay delivery may have ACKed requests synchronously during
    // connect. An admitted request still awaiting a terminal result is
    // retransmitted as a resync probe: the host high-water mark rejects
    // re-execution and returns authenticated resync, allowing the client to
    // surface an explicit outcome_unknown if the result was lost.
    for (const request of this.#requestsInSequenceOrder()) {
      if (this.#streamTerminated) {
        break;
      }
      if (request.terminal) {
        continue;
      }
      if (
        !request.admitted
        && !request.retryOnReconnect
        && request.relayStatus === "queued"
      ) {
        // The relay still owns the lowest unadmitted sequence. Never skip it
        // to transmit a higher historical request.
        break;
      }
      this.#tryTransmit(request);
      // One explicit reconnect performs at most one retry/probe. In
      // particular, never pipeline a higher sequence behind a retryable head.
      break;
    }
  }

  disconnect(): void {
    this.#connection?.disconnect();
    this.#connection = undefined;
  }

  sendRequest<Operation extends RemoteControlOperation>(
    request: FakeMobileRequest<Operation>,
  ): FakeMobileRequestReceipt;
  sendRequest<Operation extends RemoteControlOperation>(
    operation: Operation,
    payload: RemoteControlOperationPayloadMap[Operation],
  ): FakeMobileRequestReceipt;
  sendRequest<Operation extends RemoteControlOperation>(
    requestOrOperation: FakeMobileRequest<Operation> | Operation,
    suppliedPayload?: RemoteControlOperationPayloadMap[Operation],
  ): FakeMobileRequestReceipt {
    if (this.#streamTerminated) {
      throw new FakeMobileClientError("STREAM_TERMINATED");
    }
    if (this.#hasAdmissionPending()) {
      throw new FakeMobileClientError("ADMISSION_PENDING");
    }
    if (this.#tracked.size >= this.#maxTrackedRequests) {
      throw new FakeMobileClientError("TRACKED_REQUEST_LIMIT_EXCEEDED");
    }
    if (this.#nextSequence > REMOTE_CONTROL_LIMITS.maxSequence) {
      throw new FakeMobileClientError("SEQUENCE_EXHAUSTED");
    }

    const operation =
      typeof requestOrOperation === "string"
        ? requestOrOperation
        : requestOrOperation.operation;
    const payload =
      typeof requestOrOperation === "string"
        ? suppliedPayload
        : requestOrOperation.payload;
    const capability = requiredCapabilityForOperation(operation);
    if (!this.#pairing.capabilities.includes(capability)) {
      throw new FakeMobileClientError("CAPABILITY_NOT_GRANTED");
    }

    const sequence = this.#nextSequence;
    const parsed = parseRemoteControlFrame({
      version: REMOTE_CONTROL_PROTOCOL_VERSION,
      type: "request",
      hostId: this.hostId,
      sessionId: this.sessionId,
      deviceId: this.#identity.deviceId,
      credential: this.#pairing.credential,
      sequence,
      requestId: this.#requestIdFactory(),
      capability,
      operation,
      payload,
    });
    if (parsed.type !== "request") {
      throw new FakeMobileClientError("RESPONSE_CORRELATION_MISMATCH");
    }

    const tracked: TrackedRequest = {
      frame: parsed,
      admitted: false,
      terminal: false,
      retryOnReconnect: false,
    };
    this.#tracked.set(sequence, tracked);
    this.#nextSequence += 1;

    try {
      const status = this.connected
        ? this.#transmit(tracked).status
        : "retained_offline";
      return { sequence, requestId: parsed.requestId, status };
    } catch (error) {
      // Initial admission failed atomically, so it must not create a local
      // sequence gap that prevents a later valid request.
      this.#tracked.delete(sequence);
      this.#nextSequence = sequence;
      throw error;
    }
  }

  request<Operation extends RemoteControlOperation>(
    request: FakeMobileRequest<Operation>,
  ): FakeMobileRequestReceipt {
    return this.sendRequest(request);
  }

  /**
   * Accept a host envelope without ever throwing into the relay transport.
   * Returns false for forgery, replay, wrong host/session, or stale correlation.
   */
  acceptEnvelope(envelope: OpaqueRelayEnvelope): boolean {
    try {
      const inner = openRelayEnvelope<unknown>(this.#pairing.channel, envelope, {
        expectedDirection: "host_to_device",
        maxCiphertextBytes: REMOTE_CONTROL_LIMITS.maxCiphertextBytes,
        replayGuard: this.#replayGuard,
      });
      const frame = parseRemoteControlFrame(inner);
      this.#acceptFrame(frame);
      this.#lastInboundErrorCode = undefined;
      return true;
    } catch (error) {
      this.#rejectedInbound += 1;
      this.#lastInboundErrorCode = stableErrorCode(error);
      return false;
    }
  }

  receivedFrames(): readonly RemoteControlFrame[] {
    return Object.freeze(this.#received.map((frame) => parseRemoteControlFrame(frame)));
  }

  takeReceivedFrames(): readonly RemoteControlFrame[] {
    const frames = this.receivedFrames();
    this.#received.length = 0;
    return frames;
  }

  outcomeUnknown(): readonly FakeMobileOutcomeUnknown[] {
    return Object.freeze(this.#outcomeUnknown.map((outcome) => ({ ...outcome })));
  }

  takeOutcomeUnknown(): readonly FakeMobileOutcomeUnknown[] {
    const outcomes = this.outcomeUnknown();
    this.#outcomeUnknown.length = 0;
    return outcomes;
  }

  /** Safe diagnostics: no route, device id, bearer credential, key, or payload. */
  snapshot(): FakeMobileClientSnapshot {
    const snapshot: FakeMobileClientSnapshot = {
      connected: this.connected,
      streamTerminated: this.#streamTerminated,
      nextSequence: this.#nextSequence,
      acknowledgedSequence: this.#acknowledgedSequence,
      unackedSequences: this.unackedSequences,
      trackedRequests: this.#tracked.size,
      receivedFrames: this.#received.length,
      rejectedInbound: this.#rejectedInbound,
      outboundFailures: this.#outboundFailures,
      replayEntries: this.#replayGuard.size,
      outcomeUnknownSequences: Object.freeze(
        this.#outcomeUnknown.map((outcome) => outcome.sequence),
      ),
      ...(this.#lastInboundErrorCode === undefined
        ? {}
        : { lastInboundErrorCode: this.#lastInboundErrorCode }),
    };
    return snapshot;
  }

  #acceptFrame(frame: RemoteControlFrame): void {
    if (frame.hostId !== this.hostId) {
      throw new FakeMobileClientError("HOST_MISMATCH");
    }
    if (frame.sessionId !== this.sessionId) {
      throw new FakeMobileClientError("SESSION_MISMATCH");
    }

    switch (frame.type) {
      case "request":
        throw new FakeMobileClientError("UNEXPECTED_REQUEST_FRAME");
      case "ack":
        this.#acceptAck(frame.sequence, frame.requestId, frame.acknowledgedSequence);
        break;
      case "result":
        this.#acceptResult(frame.sequence, frame.requestId);
        break;
      case "error":
        this.#acceptError(
          frame.sequence,
          frame.requestId,
          frame.admitted,
          frame.error.retryable,
        );
        break;
      case "resync":
        this.#acceptResync(frame.acknowledgedSequence, frame.expectedSequence);
        break;
    }
    this.#recordFrame(frame);
  }

  #acceptAck(
    sequence: number,
    requestId: RemoteControlRequestId,
    acknowledgedSequence: number,
  ): void {
    const request = this.#correlatedRequest(sequence, requestId);
    if (
      request.admitted ||
      request.terminal ||
      acknowledgedSequence !== sequence ||
      acknowledgedSequence !== this.#acknowledgedSequence + 1
    ) {
      throw new FakeMobileClientError("ACK_STALE_OR_FUTURE");
    }
    request.admitted = true;
    request.retryOnReconnect = false;
    this.#acknowledgedSequence = acknowledgedSequence;
  }

  #acceptResult(
    sequence: number,
    requestId: RemoteControlRequestId,
  ): void {
    const request = this.#correlatedRequest(sequence, requestId);
    if (request.terminal) {
      throw new FakeMobileClientError("RESPONSE_NOT_PENDING");
    }
    if (!request.admitted) {
      throw new FakeMobileClientError("RESULT_BEFORE_ACK");
    }
    this.#settleRequest(sequence, request);
  }

  #acceptError(
    sequence: number,
    requestId: RemoteControlRequestId,
    admitted: boolean,
    retryable: boolean,
  ): void {
    const request = this.#correlatedRequest(sequence, requestId);
    if (request.terminal) {
      throw new FakeMobileClientError("RESPONSE_NOT_PENDING");
    }

    if (admitted) {
      // A terminal error is also admission evidence. When the separate ACK was
      // lost, only the next sequence may advance the high-water. Validate the
      // whole transition before mutating either the request or stream state.
      if (!request.admitted && sequence !== this.#acknowledgedSequence + 1) {
        throw new FakeMobileClientError("ERROR_STALE_OR_FUTURE");
      }
      if (!request.admitted) {
        request.admitted = true;
        this.#acknowledgedSequence = sequence;
      }
      this.#settleRequest(sequence, request);
      return;
    }

    // A host cannot retract admission after an authenticated ACK, and an
    // unadmitted error for any sequence other than the next one is stale or
    // future. Both checks precede all state changes.
    if (request.admitted || sequence !== this.#acknowledgedSequence + 1) {
      throw new FakeMobileClientError("ERROR_STALE_OR_FUTURE");
    }
    if (retryable) {
      // Retain the exact request and sequence. Clearing the transport status
      // ensures a disconnect/reconnect re-encrypts it with a fresh message id.
      request.retryOnReconnect = true;
      delete request.relayStatus;
      return;
    }

    // A non-retryable rejection did not consume the sequence, so silently
    // continuing at nextSequence would create an unrecoverable gap. Terminate
    // the complete credential-bound stream and discard every pending bearer.
    this.#streamTerminated = true;
    this.#tracked.clear();
  }

  #settleRequest(sequence: number, request: TrackedRequest): void {
    request.terminal = true;
    // A terminal response is sufficient to stop retries. Keeping only the
    // bounded frame history preserves observability without retaining bearer
    // credentials in settled request state.
    this.#tracked.delete(sequence);
  }

  #acceptResync(acknowledgedSequence: number, expectedSequence: number): void {
    if (acknowledgedSequence < this.#acknowledgedSequence) {
      throw new FakeMobileClientError("RESYNC_ACK_REGRESSION");
    }
    if (acknowledgedSequence >= this.#nextSequence) {
      throw new FakeMobileClientError("RESYNC_FUTURE_ACK");
    }

    // Validate the complete transition before mutating any request state.
    for (
      let sequence = this.#acknowledgedSequence + 1;
      sequence <= acknowledgedSequence;
      sequence += 1
    ) {
      const request = this.#tracked.get(sequence);
      if (request === undefined || request.terminal) {
        throw new FakeMobileClientError("RESYNC_HISTORY_MISSING");
      }
    }
    for (let sequence = expectedSequence; sequence < this.#nextSequence; sequence += 1) {
      const request = this.#tracked.get(sequence);
      if (request === undefined || request.terminal) {
        throw new FakeMobileClientError("RESYNC_HISTORY_MISSING");
      }
    }

    // Resync proves that the host admitted these sequences, but it cannot
    // recover a result that was lost before reconnect. Surface an explicit
    // bounded local outcome instead of retaining a request forever or
    // pretending the service succeeded.
    for (const [sequence, request] of this.#tracked) {
      if (sequence > acknowledgedSequence || request.terminal) {
        continue;
      }
      this.#recordOutcomeUnknown({
        type: "local_error",
        code: "outcome_unknown",
        reason: "resync_required",
        sequence,
        requestId: request.frame.requestId,
      });
      request.terminal = true;
      this.#tracked.delete(sequence);
    }
    this.#acknowledgedSequence = acknowledgedSequence;

    for (let sequence = expectedSequence; sequence < this.#nextSequence; sequence += 1) {
      const request = this.#tracked.get(sequence);
      if (request === undefined) {
        // The validation pass above makes this unreachable unless internal
        // state was mutated reentrantly by an observer.
        throw new FakeMobileClientError("RESYNC_HISTORY_MISSING");
      }
      request.admitted = false;
      request.retryOnReconnect = true;
      delete request.relayStatus;
    }
  }

  #hasAdmissionPending(): boolean {
    for (const request of this.#tracked.values()) {
      if (!request.admitted && !request.terminal) {
        return true;
      }
    }
    return false;
  }

  #correlatedRequest(
    sequence: number,
    requestId: RemoteControlRequestId,
  ): TrackedRequest {
    const request = this.#tracked.get(sequence);
    if (request === undefined) {
      throw new FakeMobileClientError("RESPONSE_NOT_PENDING");
    }
    if (request.frame.requestId !== requestId) {
      throw new FakeMobileClientError("RESPONSE_CORRELATION_MISMATCH");
    }
    return request;
  }

  #transmit(request: TrackedRequest): RelaySendResult {
    const sealed = sealRelayEnvelope(
      this.#pairing.channel,
      "device_to_host",
      request.frame,
      {
        clock: this.#clock,
        ...(this.#messageIdFactory === undefined
          ? {}
          : { messageId: this.#messageIdFactory() }),
      },
    );
    const envelope = parseOpaqueRelayEnvelope(sealed);
    const connection = this.#connection;
    if (connection === undefined || !connection.connected) {
      return { status: "queued" };
    }
    request.retryOnReconnect = false;
    const result = connection.send(envelope);
    // A synchronous authenticated retryable error can request another retry
    // while connection.send is still on the stack. Do not overwrite it.
    if (!request.retryOnReconnect) {
      request.relayStatus = result.status;
    }
    return result;
  }

  #tryTransmit(request: TrackedRequest): void {
    if (
      this.#streamTerminated
      || this.#tracked.get(request.frame.sequence) !== request
    ) {
      return;
    }
    try {
      this.#transmit(request);
    } catch {
      this.#outboundFailures += 1;
    }
  }

  #requestsInSequenceOrder(): TrackedRequest[] {
    return [...this.#tracked.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, request]) => request);
  }

  #recordFrame(frame: RemoteControlFrame): void {
    if (this.#received.length >= this.#maxReceivedFrames) {
      this.#received.shift();
    }
    this.#received.push(frame);
    try {
      this.#onFrame?.(parseRemoteControlFrame(frame));
    } catch {
      // A test observer cannot break transport state or turn a valid encrypted
      // delivery into an application-level retry.
    }
  }

  #recordOutcomeUnknown(outcome: FakeMobileOutcomeUnknown): void {
    if (this.#outcomeUnknown.length >= this.#maxReceivedFrames) {
      this.#outcomeUnknown.shift();
    }
    this.#outcomeUnknown.push(outcome);
    try {
      this.#onOutcomeUnknown?.({ ...outcome });
    } catch {
      // Observers cannot break authenticated state transitions.
    }
  }
}

function randomIdentifier(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("base64url")}`;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function stableErrorCode(error: unknown): string {
  if (error instanceof FakeMobileClientError || error instanceof PairingSecurityError) {
    return error.code;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code.slice(0, 64);
  }
  return "INBOUND_REJECTED";
}
