import { createHash } from "node:crypto";

import {
  REMOTE_CONTROL_LIMITS,
  REMOTE_CONTROL_PROTOCOL_VERSION,
  parseOpaqueRelayEnvelope,
  parseRemoteControlFrame,
  parseRemoteControlHostId,
  parseRemoteControlRouteId,
  requiredCapabilityForOperation,
  type OpaqueRelayEnvelope,
  type RemoteControlCapability,
  type RemoteControlErrorCode,
  type RemoteControlErrorFrame,
  type RemoteControlFrame,
  type RemoteControlHostId,
  type RemoteControlJsonValue,
  type RemoteControlOperation,
  type RemoteControlOperationPayloadMap,
  type RemoteControlRelayDirection,
  type RemoteControlRequestFrame,
  type RemoteControlRequestId,
  type RemoteControlRouteId,
  type RemoteControlSessionId,
} from "./protocol.js";

type MaybePromise<Value> = Value | Promise<Value>;

export type RemoteControlServiceRequest = {
  [Operation in RemoteControlOperation]: Readonly<{
    operation: Operation;
    payload: RemoteControlOperationPayloadMap[Operation];
  }>;
}[RemoteControlOperation];

export interface RemoteControlInvocationContext {
  readonly hostId: RemoteControlHostId;
  readonly deviceId: string;
  readonly sessionId: RemoteControlSessionId;
  readonly sequence: number;
  readonly requestId: RemoteControlRequestId;
  /** Stable per request and suitable for a future host adapter's deduplication key. */
  readonly idempotencyKey: string;
  readonly capability: RemoteControlCapability;
}

/**
 * The only host-facing seam in Phase 0. It intentionally has no Electron,
 * HTTP, or DesktopControlService dependency.
 */
export interface RemoteControlService {
  invoke(
    request: RemoteControlServiceRequest,
    context: RemoteControlInvocationContext,
  ): MaybePromise<RemoteControlJsonValue>;
}

/** Short host-neutral name used by future runtime/desktop adapters. */
export type ControlService = RemoteControlService;

export interface HostBridgeCredentialAuthorization {
  readonly credentialHash: string;
  readonly hostId: string;
  readonly deviceId: string;
  readonly routeId: string;
  readonly capabilities: readonly RemoteControlCapability[];
  readonly expiresAt: number;
}

/** Structurally implemented by InMemoryCredentialStore and InMemoryPairingAuthority. */
export interface HostBridgeCredentialAuthorizer {
  authenticate(input: {
    credential: string;
    hostId: string;
    deviceId: string;
    routeId: string;
    capability: RemoteControlCapability;
  }): HostBridgeCredentialAuthorization;
}

interface HostBridgeOpenEnvelopeOptions {
  expectedDirection?: RemoteControlRelayDirection;
}

/** Structurally implemented by InMemoryPairingAuthority. */
export interface HostBridgeEnvelopeCodec {
  openRelayEnvelope<Value>(
    envelope: unknown,
    options?: HostBridgeOpenEnvelopeOptions,
  ): MaybePromise<Value>;
  sealRelayEnvelope<Value>(
    routeId: string,
    direction: RemoteControlRelayDirection,
    inner: Value,
  ): MaybePromise<unknown>;
}

export interface HostBridgeRelayConnection {
  readonly connected: boolean;
  readonly routeId: string;
  send(envelope: OpaqueRelayEnvelope): unknown;
  disconnect(): void;
}

export interface HostBridgeRelay {
  /**
   * The bridge validates these route-level hard bounds before connecting.
   * This is required because connectHost may synchronously hand off the entire
   * offline route queue before it returns a connection handle.
   */
  readonly limits: {
    readonly maxMessageBytes: number;
    readonly maxQueuedMessagesPerRoute: number;
    readonly maxQueuedBytesPerRoute: number;
  };
  connectHost(options: {
    routeId: string;
    onMessage(envelope: OpaqueRelayEnvelope): void;
  }): HostBridgeRelayConnection;
}

export interface HostBridgeLimits {
  /** Ciphertext admitted by this host, which may be lower than the protocol ceiling. */
  readonly maxMessageBytes: number;
  /** Includes the message currently being processed. */
  readonly maxPendingMessages: number;
  /** Includes ciphertext for the message currently being processed. */
  readonly maxPendingBytes: number;
  /** Bounds durable high-water marks retained across reconnects. */
  readonly maxSessionStreams: number;
  /** Bounds authenticated envelope ids retained for one relay connection. */
  readonly maxEnvelopeReplayEntries: number;
}

export interface HostBridgeOptions {
  hostId: string;
  routeId: string;
  controlService: RemoteControlService;
  credentials: HostBridgeCredentialAuthorizer;
  codec: HostBridgeEnvelopeCodec;
  now?: () => number;
  limits?: Partial<HostBridgeLimits>;
}

export interface HostBridgeSnapshot {
  readonly connected: boolean;
  readonly pendingMessages: number;
  readonly pendingBytes: number;
  readonly sessionStreams: number;
  readonly envelopeReplayEntries: number;
}

export type HostBridgeReceiveResult =
  | Readonly<{
    status: "accepted";
    sequence: number;
    requestId: RemoteControlRequestId;
    acknowledgementSent: boolean;
    responseSent: boolean;
    completion: "succeeded" | "request_failed" | "result_rejected";
  }>
  | Readonly<{
    status: "rejected";
    code: RemoteControlErrorCode;
    admitted: false;
    responseSent: boolean;
  }>
  | Readonly<{
    status: "resync";
    admitted: false;
    acknowledgedSequence: number;
    expectedSequence: number;
    responseSent: boolean;
  }>;

interface SessionHighWaterMark {
  sessionId: RemoteControlSessionId;
  lastAcceptedSequence: number;
  lastRequestId: RemoteControlRequestId;
  expiresAt: number;
}

type FrameSendResult = "sent" | "unavailable" | "encoding_failed";

const DEFAULT_HOST_BRIDGE_LIMITS: HostBridgeLimits = Object.freeze({
  maxMessageBytes: REMOTE_CONTROL_LIMITS.maxCiphertextBytes,
  maxPendingMessages: REMOTE_CONTROL_LIMITS.maxQueueMessages,
  maxPendingBytes: REMOTE_CONTROL_LIMITS.maxQueueBytes,
  maxSessionStreams: 128,
  maxEnvelopeReplayEntries: 4_096,
});

/**
 * Authenticated, capability-scoped bridge from an opaque relay to a neutral
 * host control service.
 *
 * Requests are processed through one admission actor. Once a sequence is
 * committed it is never rolled back, including when the host service or the
 * response transport fails. This gives side-effecting operations at-most-once
 * execution within a credential/control-session stream.
 */
export class HostBridge {
  readonly hostId: RemoteControlHostId;
  readonly routeId: RemoteControlRouteId;
  readonly limits: HostBridgeLimits;

  readonly #controlService: RemoteControlService;
  readonly #credentials: HostBridgeCredentialAuthorizer;
  readonly #codec: HostBridgeEnvelopeCodec;
  readonly #now: () => number;
  readonly #sessionHighWater = new Map<string, SessionHighWaterMark>();
  readonly #seenEnvelopeIds = new Set<string>();
  readonly #seenEnvelopeOrder: string[] = [];

  #relay: HostBridgeRelay | undefined;
  #connection: HostBridgeRelayConnection | undefined;
  #connectionEpoch = 0;
  #pendingMessages = 0;
  #pendingBytes = 0;
  #processingTail: Promise<void> = Promise.resolve();

  constructor(options: HostBridgeOptions) {
    this.hostId = parseRemoteControlHostId(options.hostId);
    this.routeId = parseRemoteControlRouteId(options.routeId);
    this.#controlService = options.controlService;
    this.#credentials = options.credentials;
    this.#codec = options.codec;
    this.#now = options.now ?? Date.now;
    this.limits = parseLimits(options.limits);
  }

  get connected(): boolean {
    return this.#connection?.connected === true;
  }

  /**
   * Let the bridge create the host relay connection itself. This permits a
   * relay to synchronously drain its offline queue without racing bridge setup.
   */
  connect(relay: HostBridgeRelay): void {
    if (this.#connection?.connected === true) {
      throw new Error("Host bridge is already connected");
    }
    assertRelayLimitsFitBridge(
      relay,
      this.limits,
      this.#pendingMessages,
      this.#pendingBytes,
    );

    const epoch = this.#connectionEpoch + 1;
    this.#connectionEpoch = epoch;
    this.#seenEnvelopeIds.clear();
    this.#seenEnvelopeOrder.length = 0;

    let ready = false;
    let bufferedBytes = 0;
    const buffered: OpaqueRelayEnvelope[] = [];
    const connection = relay.connectHost({
      routeId: this.routeId,
      onMessage: (envelope) => {
        if (!ready) {
          const bytes = safeEnvelopeByteLength(envelope);
          if (
            buffered.length >= this.limits.maxPendingMessages
            || bytes > this.limits.maxPendingBytes - bufferedBytes
          ) {
            // The relay's declared per-route bounds were checked before
            // connectHost. Reaching this branch is a connector contract bug;
            // never silently acknowledge ownership and drop the ciphertext.
            throw new Error("Host relay exceeded its declared route queue limits");
          }
          buffered.push(envelope);
          bufferedBytes += bytes;
          return;
        }
        this.#receiveFromRelay(envelope, epoch);
      },
    });

    if (connection.routeId !== this.routeId || connection.connected !== true) {
      connection.disconnect();
      this.#connectionEpoch += 1;
      throw new Error("Host relay connection did not bind the configured route");
    }

    this.#relay = relay;
    this.#connection = connection;
    ready = true;
    for (const envelope of buffered) this.#receiveFromRelay(envelope, epoch);
  }

  disconnect(): void {
    const connection = this.#connection;
    this.#connection = undefined;
    this.#connectionEpoch += 1;
    this.#seenEnvelopeIds.clear();
    this.#seenEnvelopeOrder.length = 0;
    connection?.disconnect();
  }

  reconnect(relay: HostBridgeRelay | undefined = this.#relay): void {
    if (relay === undefined) throw new Error("Host bridge has no relay to reconnect");
    this.disconnect();
    this.connect(relay);
  }

  /** Deterministic receive entry point used by relay adapters and security tests. */
  receive(candidate: OpaqueRelayEnvelope): Promise<HostBridgeReceiveResult> {
    return this.#admitEnvelope(candidate, this.#connectionEpoch);
  }

  snapshot(): HostBridgeSnapshot {
    return {
      connected: this.connected,
      pendingMessages: this.#pendingMessages,
      pendingBytes: this.#pendingBytes,
      sessionStreams: this.#sessionHighWater.size,
      envelopeReplayEntries: this.#seenEnvelopeIds.size,
    };
  }

  /** Wait until every envelope admitted so far (including relay callbacks) settles. */
  async whenIdle(): Promise<void> {
    while (true) {
      const tail = this.#processingTail;
      await tail;
      if (tail === this.#processingTail && this.#pendingMessages === 0) return;
    }
  }

  #receiveFromRelay(envelope: OpaqueRelayEnvelope, epoch: number): void {
    void this.#admitEnvelope(envelope, epoch);
  }

  #admitEnvelope(
    candidate: OpaqueRelayEnvelope,
    epoch: number,
  ): Promise<HostBridgeReceiveResult> {
    const connection = this.#connection;
    if (
      connection === undefined
      || connection.connected !== true
      || epoch !== this.#connectionEpoch
    ) {
      return Promise.resolve(rejected("unavailable"));
    }

    let envelope: OpaqueRelayEnvelope;
    try {
      envelope = parseOpaqueRelayEnvelope(candidate);
    } catch {
      return Promise.resolve(rejected("invalid_frame"));
    }
    if (envelope.routeId !== this.routeId || envelope.direction !== "device_to_host") {
      return Promise.resolve(rejected("authentication_failed"));
    }
    if (envelope.byteLength > this.limits.maxMessageBytes) {
      return Promise.resolve(rejected("limit_exceeded"));
    }
    if (
      this.#pendingMessages >= this.limits.maxPendingMessages
      || envelope.byteLength > this.limits.maxPendingBytes - this.#pendingBytes
    ) {
      return Promise.resolve(rejected("limit_exceeded"));
    }

    this.#pendingMessages += 1;
    this.#pendingBytes += envelope.byteLength;
    const processing = this.#processingTail
      .then(() => this.#processEnvelope(envelope, epoch))
      .catch(() => rejected("internal_error"));
    this.#processingTail = processing.then(() => undefined);
    return processing.finally(() => {
      this.#pendingMessages -= 1;
      this.#pendingBytes -= envelope.byteLength;
    });
  }

  async #processEnvelope(
    envelope: OpaqueRelayEnvelope,
    epoch: number,
  ): Promise<HostBridgeReceiveResult> {
    if (!this.#isCurrentConnection(epoch)) return rejected("unavailable");

    const replayKey = `${envelope.direction}\u0000${envelope.messageId}`;
    const exactEnvelopeReplay = this.#seenEnvelopeIds.has(replayKey);
    let decoded: unknown;
    try {
      decoded = await this.#codec.openRelayEnvelope<unknown>(envelope, {
        expectedDirection: "device_to_host",
      });
    } catch (error) {
      return rejected(codecFailureCode(error));
    }
    this.#recordEnvelopeId(replayKey);

    let frame: RemoteControlRequestFrame;
    try {
      const parsed = parseRemoteControlFrame(decoded);
      if (parsed.type !== "request") return rejected("invalid_frame");
      frame = parsed;
    } catch {
      return rejected("invalid_frame");
    }

    if (frame.hostId !== this.hostId) {
      return this.#rejectFrame(frame, "authentication_failed", false);
    }
    const requiredCapability = requiredCapabilityForOperation(frame.operation);
    if (frame.capability !== requiredCapability) {
      return this.#rejectFrame(frame, "forbidden", false);
    }

    let authorization: HostBridgeCredentialAuthorization;
    try {
      authorization = this.#credentials.authenticate({
        credential: frame.credential,
        hostId: this.hostId,
        deviceId: frame.deviceId,
        routeId: envelope.routeId,
        capability: requiredCapability,
      });
    } catch (error) {
      return this.#rejectFrame(frame, credentialFailureCode(error), false);
    }

    const now = this.#readNow();
    const authorizationFailure = validateAuthorization(
      authorization,
      frame,
      envelope.routeId,
      requiredCapability,
      now,
    );
    if (authorizationFailure !== undefined) {
      return this.#rejectFrame(frame, authorizationFailure, false);
    }
    if (!this.#isCurrentConnection(epoch)) return rejected("unavailable");

    this.#purgeExpiredStreams(now);
    const streamKey = streamHighWaterKey(authorization, envelope.routeId);
    const current = this.#sessionHighWater.get(streamKey);
    if (current !== undefined && current.sessionId !== frame.sessionId) {
      return this.#rejectFrame(frame, "authentication_failed", false);
    }
    const acknowledgedSequence = current?.lastAcceptedSequence ?? 0;
    const expectedSequence = acknowledgedSequence + 1;

    if (frame.sequence < expectedSequence) {
      if (acknowledgedSequence >= REMOTE_CONTROL_LIMITS.maxSequence) {
        return this.#rejectFrame(frame, "replay_detected", false);
      }
      return this.#resyncFrame(frame, acknowledgedSequence, "ack_timeout");
    }
    if (frame.sequence > expectedSequence) {
      return this.#resyncFrame(frame, acknowledgedSequence, "sequence_gap");
    }
    // If a prior authenticated handling of this exact ciphertext did not
    // consume its sequence, fail closed. A duplicate of an admitted request
    // was handled above as a resync so a client can recover a lost ACK.
    if (exactEnvelopeReplay) {
      return this.#rejectFrame(frame, "replay_detected", false);
    }
    if (current === undefined && this.#sessionHighWater.size >= this.limits.maxSessionStreams) {
      return this.#rejectFrame(frame, "limit_exceeded", true);
    }

    // Atomic admission boundary: never roll this back, even if invoke/send fails.
    this.#sessionHighWater.set(streamKey, {
      sessionId: frame.sessionId,
      lastAcceptedSequence: frame.sequence,
      lastRequestId: frame.requestId,
      expiresAt: authorization.expiresAt,
    });

    const acknowledgementSent = await this.#sendFrame({
      version: REMOTE_CONTROL_PROTOCOL_VERSION,
      type: "ack",
      hostId: this.hostId,
      sessionId: frame.sessionId,
      sequence: frame.sequence,
      requestId: frame.requestId,
      acknowledgedSequence: frame.sequence,
    }) === "sent";

    let result: RemoteControlJsonValue;
    try {
      result = await this.#controlService.invoke(
        serviceRequest(frame),
        Object.freeze({
          hostId: this.hostId,
          deviceId: frame.deviceId,
          sessionId: frame.sessionId,
          sequence: frame.sequence,
          requestId: frame.requestId,
          idempotencyKey: invocationIdempotencyKey(
            this.hostId,
            authorization.credentialHash,
            frame,
            envelope.routeId,
          ),
          capability: requiredCapability,
        }),
      );
    } catch {
      const responseSent = await this.#sendErrorFrame(
        frame,
        "request_failed",
        "Control request failed",
        true,
        false,
      );
      return {
        status: "accepted",
        sequence: frame.sequence,
        requestId: frame.requestId,
        acknowledgementSent,
        responseSent,
        completion: "request_failed",
      };
    }

    let resultFrame: RemoteControlFrame;
    try {
      resultFrame = parseRemoteControlFrame({
        version: REMOTE_CONTROL_PROTOCOL_VERSION,
        type: "result",
        hostId: this.hostId,
        sessionId: frame.sessionId,
        sequence: frame.sequence,
        requestId: frame.requestId,
        result,
      });
    } catch {
      const responseSent = await this.#sendErrorFrame(
        frame,
        "limit_exceeded",
        "Control result exceeded a protocol limit",
        true,
        false,
      );
      return {
        status: "accepted",
        sequence: frame.sequence,
        requestId: frame.requestId,
        acknowledgementSent,
        responseSent,
        completion: "result_rejected",
      };
    }

    const resultSend = await this.#sendFrame(resultFrame);
    if (resultSend === "encoding_failed") {
      const responseSent = await this.#sendErrorFrame(
        frame,
        "limit_exceeded",
        "Control result exceeded an encrypted message limit",
        true,
        false,
      );
      return {
        status: "accepted",
        sequence: frame.sequence,
        requestId: frame.requestId,
        acknowledgementSent,
        responseSent,
        completion: "result_rejected",
      };
    }
    return {
      status: "accepted",
      sequence: frame.sequence,
      requestId: frame.requestId,
      acknowledgementSent,
      responseSent: resultSend === "sent",
      completion: "succeeded",
    };
  }

  async #rejectFrame(
    frame: RemoteControlRequestFrame,
    code: RemoteControlErrorCode,
    retryable: boolean,
  ): Promise<HostBridgeReceiveResult> {
    return {
      status: "rejected",
      code,
      admitted: false,
      responseSent: await this.#sendErrorFrame(
        frame,
        code,
        errorMessage(code),
        false,
        retryable,
      ),
    };
  }

  async #resyncFrame(
    frame: RemoteControlRequestFrame,
    acknowledgedSequence: number,
    reason: "sequence_gap" | "ack_timeout",
  ): Promise<HostBridgeReceiveResult> {
    const expectedSequence = acknowledgedSequence + 1;
    const responseSent = await this.#sendFrame({
      version: REMOTE_CONTROL_PROTOCOL_VERSION,
      type: "resync",
      hostId: this.hostId,
      sessionId: frame.sessionId,
      acknowledgedSequence,
      expectedSequence,
      reason,
    }) === "sent";
    return {
      status: "resync",
      admitted: false,
      acknowledgedSequence,
      expectedSequence,
      responseSent,
    };
  }

  async #sendErrorFrame(
    request: RemoteControlRequestFrame,
    code: RemoteControlErrorCode,
    message: string,
    admitted: boolean,
    retryable: boolean,
  ): Promise<boolean> {
    const frame: RemoteControlErrorFrame = {
      version: REMOTE_CONTROL_PROTOCOL_VERSION,
      type: "error",
      hostId: this.hostId,
      sessionId: request.sessionId,
      sequence: request.sequence,
      requestId: request.requestId,
      admitted,
      error: { code, message, retryable },
    };
    return await this.#sendFrame(frame) === "sent";
  }

  async #sendFrame(frame: RemoteControlFrame): Promise<FrameSendResult> {
    if (this.#connection?.connected !== true) return "unavailable";
    let candidate: unknown;
    try {
      candidate = await this.#codec.sealRelayEnvelope(
        this.routeId,
        "host_to_device",
        frame,
      );
    } catch {
      return "encoding_failed";
    }

    let envelope: OpaqueRelayEnvelope;
    try {
      envelope = parseOpaqueRelayEnvelope(candidate);
    } catch {
      return "encoding_failed";
    }
    if (
      envelope.routeId !== this.routeId
      || envelope.direction !== "host_to_device"
      || envelope.byteLength > this.limits.maxMessageBytes
    ) {
      return "encoding_failed";
    }

    const connection = this.#connection;
    if (connection?.connected !== true) return "unavailable";
    try {
      connection.send(envelope);
      return "sent";
    } catch {
      return "unavailable";
    }
  }

  #recordEnvelopeId(key: string): void {
    if (this.#seenEnvelopeIds.has(key)) return;
    this.#seenEnvelopeIds.add(key);
    this.#seenEnvelopeOrder.push(key);
    while (this.#seenEnvelopeOrder.length > this.limits.maxEnvelopeReplayEntries) {
      const oldest = this.#seenEnvelopeOrder.shift();
      if (oldest !== undefined) this.#seenEnvelopeIds.delete(oldest);
    }
  }

  #purgeExpiredStreams(now: number): void {
    for (const [key, stream] of this.#sessionHighWater) {
      if (now >= stream.expiresAt) this.#sessionHighWater.delete(key);
    }
  }

  #readNow(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid host bridge clock");
    return now;
  }

  #isCurrentConnection(epoch: number): boolean {
    return epoch === this.#connectionEpoch && this.#connection?.connected === true;
  }
}

function serviceRequest(frame: RemoteControlRequestFrame): RemoteControlServiceRequest {
  switch (frame.operation) {
    case "sessions.list":
      return Object.freeze({ operation: frame.operation, payload: frame.payload });
    case "session.snapshot":
      return Object.freeze({ operation: frame.operation, payload: frame.payload });
    case "session.send":
      return Object.freeze({ operation: frame.operation, payload: frame.payload });
    case "session.stop":
      return Object.freeze({ operation: frame.operation, payload: frame.payload });
  }
}

function validateAuthorization(
  authorization: HostBridgeCredentialAuthorization,
  frame: RemoteControlRequestFrame,
  routeId: RemoteControlRouteId,
  capability: RemoteControlCapability,
  now: number,
): RemoteControlErrorCode | undefined {
  if (
    typeof authorization.credentialHash !== "string"
    || authorization.credentialHash.length === 0
    || authorization.hostId !== frame.hostId
    || authorization.deviceId !== frame.deviceId
    || authorization.routeId !== routeId
  ) {
    return "authentication_failed";
  }
  if (!authorization.capabilities.includes(capability)) return "forbidden";
  if (!Number.isSafeInteger(authorization.expiresAt) || now >= authorization.expiresAt) {
    return "credential_expired";
  }
  return undefined;
}

function streamHighWaterKey(
  authorization: HostBridgeCredentialAuthorization,
  routeId: RemoteControlRouteId,
): string {
  return JSON.stringify([
    authorization.hostId,
    authorization.credentialHash,
    authorization.deviceId,
    routeId,
  ]);
}

function invocationIdempotencyKey(
  hostId: RemoteControlHostId,
  credentialHash: string,
  frame: RemoteControlRequestFrame,
  routeId: RemoteControlRouteId,
): string {
  const digest = createHash("sha256");
  digest.update("chili.remote-control.idempotency.v1\u0000", "utf8");
  for (const part of [
    hostId,
    credentialHash,
    frame.deviceId,
    routeId,
    frame.sessionId,
    String(frame.sequence),
    frame.requestId,
  ]) {
    digest.update(part, "utf8");
    digest.update("\u0000", "utf8");
  }
  return `remote_${digest.digest("hex")}`;
}

function credentialFailureCode(error: unknown): RemoteControlErrorCode {
  const code = stableErrorCode(error);
  if (code === "CREDENTIAL_EXPIRED") return "credential_expired";
  if (code === "CREDENTIAL_REVOKED") return "credential_revoked";
  if (code === "CAPABILITY_DENIED" || code === "CAPABILITY_NOT_ALLOWED") return "forbidden";
  return "authentication_failed";
}

function codecFailureCode(error: unknown): RemoteControlErrorCode {
  const code = stableErrorCode(error);
  if (code === "RELAY_REPLAYED") return "replay_detected";
  if (code === "MESSAGE_TOO_LARGE" || code === "RELAY_REPLAY_WINDOW_EXHAUSTED") {
    return "limit_exceeded";
  }
  return "authentication_failed";
}

function stableErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(code: RemoteControlErrorCode): string {
  switch (code) {
    case "credential_expired":
      return "Credential expired";
    case "credential_revoked":
      return "Credential revoked";
    case "forbidden":
      return "Capability denied";
    case "replay_detected":
      return "Request was already consumed";
    case "sequence_gap":
      return "Request sequence has a gap";
    case "limit_exceeded":
      return "Request exceeded a control limit";
    case "unavailable":
      return "Host bridge is unavailable";
    case "request_failed":
      return "Control request failed";
    case "invalid_frame":
      return "Invalid control frame";
    case "authentication_failed":
      return "Authentication failed";
    case "internal_error":
      return "Internal control error";
  }
}

function rejected(code: RemoteControlErrorCode): HostBridgeReceiveResult {
  return { status: "rejected", code, admitted: false, responseSent: false };
}

function parseLimits(overrides: Partial<HostBridgeLimits> | undefined): HostBridgeLimits {
  const limits: HostBridgeLimits = {
    maxMessageBytes: overrides?.maxMessageBytes ?? DEFAULT_HOST_BRIDGE_LIMITS.maxMessageBytes,
    maxPendingMessages: overrides?.maxPendingMessages ?? DEFAULT_HOST_BRIDGE_LIMITS.maxPendingMessages,
    maxPendingBytes: overrides?.maxPendingBytes ?? DEFAULT_HOST_BRIDGE_LIMITS.maxPendingBytes,
    maxSessionStreams: overrides?.maxSessionStreams ?? DEFAULT_HOST_BRIDGE_LIMITS.maxSessionStreams,
    maxEnvelopeReplayEntries:
      overrides?.maxEnvelopeReplayEntries ?? DEFAULT_HOST_BRIDGE_LIMITS.maxEnvelopeReplayEntries,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
  if (limits.maxMessageBytes > REMOTE_CONTROL_LIMITS.maxCiphertextBytes) {
    throw new TypeError("maxMessageBytes exceeds the protocol ciphertext limit");
  }
  return Object.freeze(limits);
}

function assertRelayLimitsFitBridge(
  relay: HostBridgeRelay,
  bridge: HostBridgeLimits,
  pendingMessages: number,
  pendingBytes: number,
): void {
  const relayLimits = relay.limits;
  if (
    !isPositiveSafeInteger(relayLimits?.maxMessageBytes)
    || !isPositiveSafeInteger(relayLimits?.maxQueuedMessagesPerRoute)
    || !isPositiveSafeInteger(relayLimits?.maxQueuedBytesPerRoute)
  ) {
    throw new TypeError("Host relay must declare positive bounded route limits");
  }
  if (relayLimits.maxMessageBytes > bridge.maxMessageBytes) {
    throw new TypeError("Host relay message limit exceeds the bridge message limit");
  }
  if (
    relayLimits.maxQueuedMessagesPerRoute
      > bridge.maxPendingMessages - pendingMessages
  ) {
    throw new TypeError("Host relay route queue count exceeds the bridge pending limit");
  }
  if (
    relayLimits.maxQueuedBytesPerRoute
      > bridge.maxPendingBytes - pendingBytes
  ) {
    throw new TypeError("Host relay route queue bytes exceed the bridge pending limit");
  }
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function safeEnvelopeByteLength(envelope: OpaqueRelayEnvelope): number {
  return Number.isSafeInteger(envelope.byteLength) && envelope.byteLength > 0
    ? envelope.byteLength
    : REMOTE_CONTROL_LIMITS.maxCiphertextBytes;
}
