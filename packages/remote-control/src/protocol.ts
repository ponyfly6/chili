export const REMOTE_CONTROL_PROTOCOL_VERSION = 1 as const;

/**
 * Phase 0 transport limits. Every queue retaining remote-control traffic must
 * account for the complete encrypted message, not only the plaintext payload.
 */
export const REMOTE_CONTROL_LIMITS = Object.freeze({
  maxFrameBytes: 65_536,
  maxCiphertextBytes: 70_000,
  maxQueueMessages: 64,
  maxQueueBytes: 1_048_576,
  maxIdentifierChars: 128,
  maxRouteIdBytes: 128,
  maxCredentialChars: 512,
  maxPromptBytes: 32_768,
  maxQueryBytes: 512,
  maxErrorMessageChars: 256,
  maxJsonDepth: 16,
  maxJsonEntries: 1_024,
  /**
   * Sequence exhaustion fails closed. Reset requires a new credential or a
   * host-authenticated epoch; changing a client-chosen session id is not a reset.
   */
  maxSequence: 2_147_483_647,
} as const);

export const REMOTE_CONTROL_CAPABILITIES = [
  "sessions.read",
  "sessions.send",
  "sessions.stop",
] as const;

export type RemoteControlCapability = (typeof REMOTE_CONTROL_CAPABILITIES)[number];

export const REMOTE_CONTROL_OPERATIONS = [
  "sessions.list",
  "session.snapshot",
  "session.send",
  "session.stop",
] as const;

export type RemoteControlOperation = (typeof REMOTE_CONTROL_OPERATIONS)[number];

/** One capability per operation keeps read, prompt, and cancellation authority independent. */
export const REMOTE_CONTROL_REQUIRED_CAPABILITY = Object.freeze({
  "sessions.list": "sessions.read",
  "session.snapshot": "sessions.read",
  "session.send": "sessions.send",
  "session.stop": "sessions.stop",
} as const satisfies Record<RemoteControlOperation, RemoteControlCapability>);

export type RemoteControlCapabilityForOperation<Operation extends RemoteControlOperation> =
  (typeof REMOTE_CONTROL_REQUIRED_CAPABILITY)[Operation];

export const REMOTE_CONTROL_ERROR_CODES = [
  "authentication_failed",
  "credential_expired",
  "credential_revoked",
  "forbidden",
  "invalid_frame",
  "replay_detected",
  "sequence_gap",
  "limit_exceeded",
  "unavailable",
  "request_failed",
  "internal_error",
] as const;

export type RemoteControlErrorCode = (typeof REMOTE_CONTROL_ERROR_CODES)[number];

export const REMOTE_CONTROL_RESYNC_REASONS = [
  "reconnect",
  "sequence_gap",
  "ack_timeout",
  "queue_overflow",
] as const;

export type RemoteControlResyncReason = (typeof REMOTE_CONTROL_RESYNC_REASONS)[number];

export const REMOTE_CONTROL_RELAY_DIRECTIONS = [
  "device_to_host",
  "host_to_device",
] as const;

export type RemoteControlRelayDirection = (typeof REMOTE_CONTROL_RELAY_DIRECTIONS)[number];

declare const remoteControlSessionIdBrand: unique symbol;
declare const remoteControlHostIdBrand: unique symbol;
declare const remoteControlDeviceIdBrand: unique symbol;
declare const remoteControlRequestIdBrand: unique symbol;
declare const remoteControlRouteIdBrand: unique symbol;
declare const remoteControlMessageIdBrand: unique symbol;

/**
 * A host-bound encrypted control stream, distinct from a Chili task session.
 * Reconnects reuse it; it grants no authority to reset the replay high-water.
 */
export type RemoteControlSessionId = string & { readonly [remoteControlSessionIdBrand]: true };
export type RemoteControlHostId = string & { readonly [remoteControlHostIdBrand]: true };
export type RemoteControlDeviceId = string & { readonly [remoteControlDeviceIdBrand]: true };
export type RemoteControlRequestId = string & { readonly [remoteControlRequestIdBrand]: true };
/** A random, rotatable channel alias. It must not contain a stable device identifier. */
export type RemoteControlRouteId = string & { readonly [remoteControlRouteIdBrand]: true };
export type RemoteControlMessageId = string & { readonly [remoteControlMessageIdBrand]: true };

export interface RemoteControlSessionsListPayload {
  query?: string;
  status?: "active" | "archived" | "all";
}

export interface RemoteControlSessionSnapshotPayload {
  sessionId: string;
}

export interface RemoteControlSessionSendPayload {
  sessionId: string;
  text: string;
  mode: "queue" | "steer";
}

export interface RemoteControlSessionStopPayload {
  sessionId: string;
}

export interface RemoteControlOperationPayloadMap {
  "sessions.list": RemoteControlSessionsListPayload;
  "session.snapshot": RemoteControlSessionSnapshotPayload;
  "session.send": RemoteControlSessionSendPayload;
  "session.stop": RemoteControlSessionStopPayload;
}

interface RemoteControlFrameBase {
  version: typeof REMOTE_CONTROL_PROTOCOL_VERSION;
  /** Stable host identity, visible only after authenticated decryption. */
  hostId: RemoteControlHostId;
  sessionId: RemoteControlSessionId;
}

export type RemoteControlRequestFrameFor<Operation extends RemoteControlOperation> =
  RemoteControlFrameBase & {
    type: "request";
    deviceId: RemoteControlDeviceId;
    credential: string;
    sequence: number;
    requestId: RemoteControlRequestId;
    capability: RemoteControlCapabilityForOperation<Operation>;
    operation: Operation;
    payload: RemoteControlOperationPayloadMap[Operation];
  };

export type RemoteControlRequestFrame = {
  [Operation in RemoteControlOperation]: RemoteControlRequestFrameFor<Operation>;
}[RemoteControlOperation];

/**
 * An ACK is emitted separately and only after a request has passed auth,
 * authorization, size, queue, and sequence checks and the bridge has atomically
 * admitted it and committed its sequence exactly once. It does not mean that
 * the control service succeeded; a result or bounded error follows. Rejected
 * or replayed requests are never acknowledged. `sequence` and
 * `acknowledgedSequence` intentionally match; the former correlates the request
 * and the latter makes cumulative ACK state explicit to reconnecting clients.
 */
export interface RemoteControlAckFrame extends RemoteControlFrameBase {
  type: "ack";
  sequence: number;
  requestId: RemoteControlRequestId;
  acknowledgedSequence: number;
}

export type RemoteControlJsonPrimitive = string | number | boolean | null;
export type RemoteControlJsonValue =
  | RemoteControlJsonPrimitive
  | RemoteControlJsonValue[]
  | { [key: string]: RemoteControlJsonValue };

export interface RemoteControlResultFrame<Result extends RemoteControlJsonValue = RemoteControlJsonValue>
  extends RemoteControlFrameBase {
  type: "result";
  sequence: number;
  requestId: RemoteControlRequestId;
  result: Result;
}

export interface RemoteControlErrorFrame extends RemoteControlFrameBase {
  type: "error";
  sequence: number;
  requestId: RemoteControlRequestId;
  /**
   * True means the bridge atomically committed this sequence before the
   * failure. It is admission evidence even when the separate ACK was lost, so
   * the client must advance its high-water and never retransmit this sequence.
   * False means the sequence remains unconsumed.
   */
  admitted: boolean;
  error: {
    code: RemoteControlErrorCode;
    message: string;
    /** Never authorizes retransmission when `admitted` is true. */
    retryable: boolean;
  };
}

/**
 * A resync is stream-level rather than request-level. The client must resume
 * at exactly `expectedSequence`; skipped or lower sequences remain invalid.
 */
export interface RemoteControlResyncFrame extends RemoteControlFrameBase {
  type: "resync";
  acknowledgedSequence: number;
  expectedSequence: number;
  reason: RemoteControlResyncReason;
}

export type RemoteControlFrame =
  | RemoteControlRequestFrame
  | RemoteControlAckFrame
  | RemoteControlResultFrame
  | RemoteControlErrorFrame
  | RemoteControlResyncFrame;

/**
 * The relay-visible envelope deliberately excludes host and device identity,
 * credential, control session, sequence, request, operation, and capability.
 * Those values exist only inside authenticated ciphertext.
 */
export interface OpaqueRelayEnvelope {
  version: typeof REMOTE_CONTROL_PROTOCOL_VERSION;
  routeId: RemoteControlRouteId;
  direction: RemoteControlRelayDirection;
  messageId: RemoteControlMessageId;
  ciphertext: Uint8Array;
  byteLength: number;
  createdAt: number;
}

export interface RemoteControlQueueUsage {
  messages: number;
  bytes: number;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const UNSAFE_TEXT_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const ERROR_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const FORBIDDEN_JSON_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

/** Value-free boundary error: hostile frame contents are never reflected into logs. */
export class RemoteControlProtocolError extends TypeError {
  readonly code = "REMOTE_CONTROL_PROTOCOL_ERROR";
  declare readonly path: string;

  constructor(path: string, expectation: string) {
    const safePath = boundedDiagnostic(path);
    const safeExpectation = boundedDiagnostic(expectation);
    super(`${safePath} ${safeExpectation}`);
    this.name = "RemoteControlProtocolError";
    Object.defineProperty(this, "path", {
      configurable: false,
      enumerable: false,
      value: safePath,
      writable: false,
    });
  }
}

export function requiredCapabilityForOperation<Operation extends RemoteControlOperation>(
  operation: Operation,
): RemoteControlCapabilityForOperation<Operation> {
  return REMOTE_CONTROL_REQUIRED_CAPABILITY[operation];
}

export function parseRemoteControlRouteId(value: unknown, path = "routeId"): RemoteControlRouteId {
  const routeId = parseIdentifier(value, path);
  if (textEncoder.encode(routeId).byteLength > REMOTE_CONTROL_LIMITS.maxRouteIdBytes) {
    throw new RemoteControlProtocolError(
      path,
      `must not exceed ${REMOTE_CONTROL_LIMITS.maxRouteIdBytes} UTF-8 bytes`,
    );
  }
  return routeId as RemoteControlRouteId;
}

export function parseRemoteControlHostId(value: unknown, path = "hostId"): RemoteControlHostId {
  return parseIdentifier(value, path) as RemoteControlHostId;
}

export function parseRemoteControlFrame(value: unknown, path = "frame"): RemoteControlFrame {
  const record = parseRecord(value, path);
  const version = parseVersion(record.version, `${path}.version`);
  const type = parseEnum(record.type, ["request", "ack", "result", "error", "resync"] as const, `${path}.type`);
  const hostId = parseRemoteControlHostId(record.hostId, `${path}.hostId`);
  const sessionId = parseIdentifier(record.sessionId, `${path}.sessionId`) as RemoteControlSessionId;

  let frame: RemoteControlFrame;
  switch (type) {
    case "request":
      frame = parseRequestFrame(record, version, hostId, sessionId, path);
      break;
    case "ack":
      frame = parseAckFrame(record, version, hostId, sessionId, path);
      break;
    case "result":
      frame = parseResultFrame(record, version, hostId, sessionId, path);
      break;
    case "error":
      frame = parseErrorFrame(record, version, hostId, sessionId, path);
      break;
    case "resync":
      frame = parseResyncFrame(record, version, hostId, sessionId, path);
      break;
  }
  assertJsonByteLimit(frame, REMOTE_CONTROL_LIMITS.maxFrameBytes, path);
  return frame;
}

export function encodeRemoteControlFrame(frame: RemoteControlFrame): Uint8Array {
  const parsed = parseRemoteControlFrame(frame);
  const encoded = textEncoder.encode(JSON.stringify(parsed));
  if (encoded.byteLength > REMOTE_CONTROL_LIMITS.maxFrameBytes) {
    throw new RemoteControlProtocolError("frame", `must not exceed ${REMOTE_CONTROL_LIMITS.maxFrameBytes} UTF-8 bytes`);
  }
  return encoded;
}

export function decodeRemoteControlFrame(encoded: Uint8Array | string): RemoteControlFrame {
  const bytes = typeof encoded === "string" ? textEncoder.encode(encoded) : encoded;
  if (!(bytes instanceof Uint8Array)) {
    throw new RemoteControlProtocolError("frame", "must be UTF-8 bytes or a string");
  }
  if (bytes.byteLength > REMOTE_CONTROL_LIMITS.maxFrameBytes) {
    throw new RemoteControlProtocolError("frame", `must not exceed ${REMOTE_CONTROL_LIMITS.maxFrameBytes} UTF-8 bytes`);
  }
  let text: string;
  try {
    text = textDecoder.decode(bytes);
  } catch {
    throw new RemoteControlProtocolError("frame", "must contain valid UTF-8");
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new RemoteControlProtocolError("frame", "must contain valid JSON");
  }
  return parseRemoteControlFrame(value);
}

export function parseOpaqueRelayEnvelope(value: unknown, path = "envelope"): OpaqueRelayEnvelope {
  const record = parseRecord(value, path);
  rejectUnknownFields(record, [
    "version",
    "routeId",
    "direction",
    "messageId",
    "ciphertext",
    "byteLength",
    "createdAt",
  ], path);
  const ciphertext = parseUint8Array(
    record.ciphertext,
    `${path}.ciphertext`,
    REMOTE_CONTROL_LIMITS.maxCiphertextBytes,
  );
  const byteLength = parsePositiveInteger(record.byteLength, `${path}.byteLength`);
  if (byteLength !== ciphertext.byteLength) {
    throw new RemoteControlProtocolError(`${path}.byteLength`, "must equal the ciphertext byte length");
  }
  if (byteLength > REMOTE_CONTROL_LIMITS.maxCiphertextBytes) {
    throw new RemoteControlProtocolError(
      `${path}.ciphertext`,
      `must not exceed ${REMOTE_CONTROL_LIMITS.maxCiphertextBytes} bytes`,
    );
  }
  return {
    version: parseVersion(record.version, `${path}.version`),
    routeId: parseRemoteControlRouteId(record.routeId, `${path}.routeId`),
    direction: parseEnum(record.direction, REMOTE_CONTROL_RELAY_DIRECTIONS, `${path}.direction`),
    messageId: parseIdentifier(record.messageId, `${path}.messageId`) as RemoteControlMessageId,
    ciphertext,
    byteLength,
    createdAt: parseNonNegativeInteger(record.createdAt, `${path}.createdAt`),
  };
}

export function assertRemoteControlQueueAdmission(
  usage: RemoteControlQueueUsage,
  incomingBytes: number,
  path = "queue",
): void {
  const messages = parseNonNegativeInteger(usage.messages, `${path}.messages`);
  const bytes = parseNonNegativeInteger(usage.bytes, `${path}.bytes`);
  const addition = parsePositiveInteger(incomingBytes, `${path}.incomingBytes`);
  if (messages >= REMOTE_CONTROL_LIMITS.maxQueueMessages) {
    throw new RemoteControlProtocolError(
      `${path}.messages`,
      `must remain below ${REMOTE_CONTROL_LIMITS.maxQueueMessages}`,
    );
  }
  if (addition > REMOTE_CONTROL_LIMITS.maxCiphertextBytes) {
    throw new RemoteControlProtocolError(
      `${path}.incomingBytes`,
      `must not exceed ${REMOTE_CONTROL_LIMITS.maxCiphertextBytes}`,
    );
  }
  if (bytes > REMOTE_CONTROL_LIMITS.maxQueueBytes - addition) {
    throw new RemoteControlProtocolError(
      `${path}.bytes`,
      `must remain within ${REMOTE_CONTROL_LIMITS.maxQueueBytes} after admission`,
    );
  }
}

export function remoteControlJsonBytes(value: RemoteControlJsonValue | RemoteControlFrame): number {
  return textEncoder.encode(JSON.stringify(value)).byteLength;
}

function parseRequestFrame(
  record: Record<string, unknown>,
  version: typeof REMOTE_CONTROL_PROTOCOL_VERSION,
  hostId: RemoteControlHostId,
  sessionId: RemoteControlSessionId,
  path: string,
): RemoteControlRequestFrame {
  rejectUnknownFields(record, [
    "version",
    "type",
    "hostId",
    "sessionId",
    "deviceId",
    "credential",
    "sequence",
    "requestId",
    "capability",
    "operation",
    "payload",
  ], path);
  const deviceId = parseIdentifier(record.deviceId, `${path}.deviceId`) as RemoteControlDeviceId;
  const credential = parseCredential(record.credential, `${path}.credential`);
  const sequence = parseSequence(record.sequence, `${path}.sequence`);
  const requestId = parseIdentifier(record.requestId, `${path}.requestId`) as RemoteControlRequestId;
  const operation = parseEnum(record.operation, REMOTE_CONTROL_OPERATIONS, `${path}.operation`);
  const capability = parseEnum(record.capability, REMOTE_CONTROL_CAPABILITIES, `${path}.capability`);
  const requiredCapability = requiredCapabilityForOperation(operation);
  if (capability !== requiredCapability) {
    throw new RemoteControlProtocolError(`${path}.capability`, "must be the capability required by the operation");
  }

  switch (operation) {
    case "sessions.list":
      return {
        version,
        type: "request",
        hostId,
        sessionId,
        deviceId,
        credential,
        sequence,
        requestId,
        capability: REMOTE_CONTROL_REQUIRED_CAPABILITY[operation],
        operation,
        payload: parseSessionsListPayload(record.payload, `${path}.payload`),
      };
    case "session.snapshot":
      return {
        version,
        type: "request",
        hostId,
        sessionId,
        deviceId,
        credential,
        sequence,
        requestId,
        capability: REMOTE_CONTROL_REQUIRED_CAPABILITY[operation],
        operation,
        payload: parseSessionTargetPayload(record.payload, `${path}.payload`),
      };
    case "session.send":
      return {
        version,
        type: "request",
        hostId,
        sessionId,
        deviceId,
        credential,
        sequence,
        requestId,
        capability: REMOTE_CONTROL_REQUIRED_CAPABILITY[operation],
        operation,
        payload: parseSessionSendPayload(record.payload, `${path}.payload`),
      };
    case "session.stop":
      return {
        version,
        type: "request",
        hostId,
        sessionId,
        deviceId,
        credential,
        sequence,
        requestId,
        capability: REMOTE_CONTROL_REQUIRED_CAPABILITY[operation],
        operation,
        payload: parseSessionTargetPayload(record.payload, `${path}.payload`),
      };
  }
}

function parseAckFrame(
  record: Record<string, unknown>,
  version: typeof REMOTE_CONTROL_PROTOCOL_VERSION,
  hostId: RemoteControlHostId,
  sessionId: RemoteControlSessionId,
  path: string,
): RemoteControlAckFrame {
  rejectUnknownFields(record, [
    "version",
    "type",
    "hostId",
    "sessionId",
    "sequence",
    "requestId",
    "acknowledgedSequence",
  ], path);
  const sequence = parseSequence(record.sequence, `${path}.sequence`);
  const acknowledgedSequence = parseSequence(
    record.acknowledgedSequence,
    `${path}.acknowledgedSequence`,
  );
  if (acknowledgedSequence !== sequence) {
    throw new RemoteControlProtocolError(`${path}.acknowledgedSequence`, "must equal the admitted request sequence");
  }
  return {
    version,
    type: "ack",
    hostId,
    sessionId,
    sequence,
    requestId: parseIdentifier(record.requestId, `${path}.requestId`) as RemoteControlRequestId,
    acknowledgedSequence,
  };
}

function parseResultFrame(
  record: Record<string, unknown>,
  version: typeof REMOTE_CONTROL_PROTOCOL_VERSION,
  hostId: RemoteControlHostId,
  sessionId: RemoteControlSessionId,
  path: string,
): RemoteControlResultFrame {
  rejectUnknownFields(record, ["version", "type", "hostId", "sessionId", "sequence", "requestId", "result"], path);
  return {
    version,
    type: "result",
    hostId,
    sessionId,
    sequence: parseSequence(record.sequence, `${path}.sequence`),
    requestId: parseIdentifier(record.requestId, `${path}.requestId`) as RemoteControlRequestId,
    result: parseJsonValue(record.result, `${path}.result`),
  };
}

function parseErrorFrame(
  record: Record<string, unknown>,
  version: typeof REMOTE_CONTROL_PROTOCOL_VERSION,
  hostId: RemoteControlHostId,
  sessionId: RemoteControlSessionId,
  path: string,
): RemoteControlErrorFrame {
  rejectUnknownFields(
    record,
    ["version", "type", "hostId", "sessionId", "sequence", "requestId", "admitted", "error"],
    path,
  );
  const error = parseRecord(record.error, `${path}.error`);
  rejectUnknownFields(error, ["code", "message", "retryable"], `${path}.error`);
  const admitted = parseBoolean(record.admitted, `${path}.admitted`);
  const retryable = parseBoolean(error.retryable, `${path}.error.retryable`);
  if (admitted && retryable) {
    throw new RemoteControlProtocolError(
      `${path}.error.retryable`,
      "must be false when the sequence was admitted",
    );
  }
  return {
    version,
    type: "error",
    hostId,
    sessionId,
    sequence: parseSequence(record.sequence, `${path}.sequence`),
    requestId: parseIdentifier(record.requestId, `${path}.requestId`) as RemoteControlRequestId,
    admitted,
    error: {
      code: parseEnum(error.code, REMOTE_CONTROL_ERROR_CODES, `${path}.error.code`),
      message: parseErrorMessage(error.message, `${path}.error.message`),
      retryable,
    },
  };
}

function parseResyncFrame(
  record: Record<string, unknown>,
  version: typeof REMOTE_CONTROL_PROTOCOL_VERSION,
  hostId: RemoteControlHostId,
  sessionId: RemoteControlSessionId,
  path: string,
): RemoteControlResyncFrame {
  rejectUnknownFields(record, [
    "version",
    "type",
    "hostId",
    "sessionId",
    "acknowledgedSequence",
    "expectedSequence",
    "reason",
  ], path);
  const acknowledgedSequence = parseNonNegativeInteger(
    record.acknowledgedSequence,
    `${path}.acknowledgedSequence`,
  );
  if (acknowledgedSequence >= REMOTE_CONTROL_LIMITS.maxSequence) {
    throw new RemoteControlProtocolError(
      `${path}.acknowledgedSequence`,
      `must be below ${REMOTE_CONTROL_LIMITS.maxSequence} so another sequence remains`,
    );
  }
  const expectedSequence = parseSequence(record.expectedSequence, `${path}.expectedSequence`);
  if (expectedSequence !== acknowledgedSequence + 1) {
    throw new RemoteControlProtocolError(
      `${path}.expectedSequence`,
      "must immediately follow the acknowledged sequence",
    );
  }
  return {
    version,
    type: "resync",
    hostId,
    sessionId,
    acknowledgedSequence,
    expectedSequence,
    reason: parseEnum(record.reason, REMOTE_CONTROL_RESYNC_REASONS, `${path}.reason`),
  };
}

function parseSessionsListPayload(value: unknown, path: string): RemoteControlSessionsListPayload {
  const record = parseRecord(value, path);
  rejectUnknownFields(record, ["query", "status"], path);
  const payload: RemoteControlSessionsListPayload = {};
  if (record.query !== undefined) {
    payload.query = parseText(record.query, `${path}.query`, REMOTE_CONTROL_LIMITS.maxQueryBytes, true);
  }
  if (record.status !== undefined) {
    payload.status = parseEnum(record.status, ["active", "archived", "all"] as const, `${path}.status`);
  }
  return payload;
}

function parseSessionTargetPayload(value: unknown, path: string): RemoteControlSessionSnapshotPayload {
  const record = parseRecord(value, path);
  rejectUnknownFields(record, ["sessionId"], path);
  return { sessionId: parseIdentifier(record.sessionId, `${path}.sessionId`) };
}

function parseSessionSendPayload(value: unknown, path: string): RemoteControlSessionSendPayload {
  const record = parseRecord(value, path);
  rejectUnknownFields(record, ["sessionId", "text", "mode"], path);
  return {
    sessionId: parseIdentifier(record.sessionId, `${path}.sessionId`),
    text: parseText(record.text, `${path}.text`, REMOTE_CONTROL_LIMITS.maxPromptBytes, false),
    mode: parseEnum(record.mode, ["queue", "steer"] as const, `${path}.mode`),
  };
}

function parseJsonValue(value: unknown, path: string): RemoteControlJsonValue {
  const state = { entries: 0 };
  return parseJsonValueAtDepth(value, path, 0, state);
}

function parseJsonValueAtDepth(
  value: unknown,
  path: string,
  depth: number,
  state: { entries: number },
): RemoteControlJsonValue {
  if (depth > REMOTE_CONTROL_LIMITS.maxJsonDepth) {
    throw new RemoteControlProtocolError(path, `must not exceed ${REMOTE_CONTROL_LIMITS.maxJsonDepth} levels`);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RemoteControlProtocolError(path, "must contain only finite numbers");
    return value;
  }
  if (Array.isArray(value)) {
    state.entries += value.length;
    assertJsonEntryLimit(state.entries, path);
    return value.map((item, index) => parseJsonValueAtDepth(item, `${path}[${index}]`, depth + 1, state));
  }
  const record = parseRecord(value, path);
  const entries = Object.entries(record);
  state.entries += entries.length;
  assertJsonEntryLimit(state.entries, path);
  const parsed: { [key: string]: RemoteControlJsonValue } = {};
  for (const [key, item] of entries) {
    if (FORBIDDEN_JSON_KEYS.has(key)) {
      throw new RemoteControlProtocolError(`${path}.*`, "must not contain a prototype-sensitive key");
    }
    parsed[key] = parseJsonValueAtDepth(item, `${path}.*`, depth + 1, state);
  }
  return parsed;
}

function assertJsonEntryLimit(entries: number, path: string): void {
  if (entries > REMOTE_CONTROL_LIMITS.maxJsonEntries) {
    throw new RemoteControlProtocolError(path, `must not exceed ${REMOTE_CONTROL_LIMITS.maxJsonEntries} entries`);
  }
}

function assertJsonByteLimit(value: RemoteControlFrame, maxBytes: number, path: string): void {
  const bytes = textEncoder.encode(JSON.stringify(value)).byteLength;
  if (bytes > maxBytes) {
    throw new RemoteControlProtocolError(path, `must not exceed ${maxBytes} UTF-8 bytes`);
  }
}

function parseRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || value instanceof Uint8Array) {
    throw new RemoteControlProtocolError(path, "must be an object");
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RemoteControlProtocolError(path, "must be a plain object");
  }
  return value as Record<string, unknown>;
}

function rejectUnknownFields(record: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const supported = new Set(allowed);
  if (Object.keys(record).some((key) => !supported.has(key))) {
    throw new RemoteControlProtocolError(`${path}.*`, "contains an unsupported field");
  }
}

function parseVersion(value: unknown, path: string): typeof REMOTE_CONTROL_PROTOCOL_VERSION {
  if (value !== REMOTE_CONTROL_PROTOCOL_VERSION) {
    throw new RemoteControlProtocolError(path, `must equal ${REMOTE_CONTROL_PROTOCOL_VERSION}`);
  }
  return REMOTE_CONTROL_PROTOCOL_VERSION;
}

function parseEnum<const Value extends string>(
  value: unknown,
  allowed: readonly Value[],
  path: string,
): Value {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new RemoteControlProtocolError(path, `must be one of ${allowed.join(", ")}`);
  }
  return value as Value;
}

function parseIdentifier(value: unknown, path: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > REMOTE_CONTROL_LIMITS.maxIdentifierChars
    || !IDENTIFIER_PATTERN.test(value)
  ) {
    throw new RemoteControlProtocolError(
      path,
      `must be a safe identifier of at most ${REMOTE_CONTROL_LIMITS.maxIdentifierChars} characters`,
    );
  }
  return value;
}

function parseCredential(value: unknown, path: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > REMOTE_CONTROL_LIMITS.maxCredentialChars
    || !CREDENTIAL_PATTERN.test(value)
  ) {
    throw new RemoteControlProtocolError(
      path,
      `must be a base64url token of at most ${REMOTE_CONTROL_LIMITS.maxCredentialChars} characters`,
    );
  }
  return value;
}

function parseText(value: unknown, path: string, maxBytes: number, allowEmpty: boolean): string {
  if (typeof value !== "string") throw new RemoteControlProtocolError(path, "must be a string");
  if (!allowEmpty && value.length === 0) throw new RemoteControlProtocolError(path, "must not be empty");
  if (UNSAFE_TEXT_CONTROL_CHARACTERS.test(value)) {
    throw new RemoteControlProtocolError(path, "must not contain unsafe control characters");
  }
  if (textEncoder.encode(value).byteLength > maxBytes) {
    throw new RemoteControlProtocolError(path, `must not exceed ${maxBytes} UTF-8 bytes`);
  }
  return value;
}

function parseErrorMessage(value: unknown, path: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > REMOTE_CONTROL_LIMITS.maxErrorMessageChars
    || ERROR_CONTROL_CHARACTERS.test(value)
  ) {
    throw new RemoteControlProtocolError(
      path,
      `must be a single-line message of at most ${REMOTE_CONTROL_LIMITS.maxErrorMessageChars} characters`,
    );
  }
  return value;
}

function parseBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new RemoteControlProtocolError(path, "must be a boolean");
  return value;
}

function parseNonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RemoteControlProtocolError(path, "must be a non-negative safe integer");
  }
  return value;
}

function parsePositiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new RemoteControlProtocolError(path, "must be a positive safe integer");
  }
  return value;
}

function parseSequence(value: unknown, path: string): number {
  const sequence = parsePositiveInteger(value, path);
  if (sequence > REMOTE_CONTROL_LIMITS.maxSequence) {
    throw new RemoteControlProtocolError(path, `must not exceed ${REMOTE_CONTROL_LIMITS.maxSequence}`);
  }
  return sequence;
}

function parseUint8Array(value: unknown, path: string, maxBytes: number): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new RemoteControlProtocolError(path, "must be a Uint8Array");
  }
  if (value.byteLength > maxBytes) {
    throw new RemoteControlProtocolError(path, `must not exceed ${maxBytes} bytes`);
  }
  // Buffer.slice() returns a shared view, so call Uint8Array.from explicitly
  // to keep relay queues isolated from mutations by the envelope sender.
  return Uint8Array.from(value);
}

function boundedDiagnostic(value: string): string {
  return value.slice(0, 256).replace(/[\u0000-\u001f\u007f]/gu, "?");
}
