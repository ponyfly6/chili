import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import {
  assertRemoteControlQueueAdmission,
  decodeRemoteControlFrame,
  encodeRemoteControlFrame,
  parseOpaqueRelayEnvelope,
  parseRemoteControlFrame,
  parseRemoteControlRouteId,
  REMOTE_CONTROL_LIMITS,
  REMOTE_CONTROL_PROTOCOL_VERSION,
  REMOTE_CONTROL_REQUIRED_CAPABILITY,
  remoteControlJsonBytes,
  RemoteControlProtocolError,
  requiredCapabilityForOperation,
} from "./protocol.js";

test("accepts the four minimal operations and enforces their exact capabilities", () => {
  const cases = [
    ["sessions.list", "sessions.read", { query: "active", status: "active" }],
    ["session.snapshot", "sessions.read", { sessionId: "task_1" }],
    ["session.send", "sessions.send", { sessionId: "task_1", text: "continue\nnow", mode: "queue" }],
    ["session.stop", "sessions.stop", { sessionId: "task_1" }],
  ] as const;

  for (const [operation, capability, payload] of cases) {
    const parsed = parseRemoteControlFrame(request({ operation, capability, payload }));
    expect(parsed).toMatchObject({ type: "request", operation, capability, payload });
    expect(requiredCapabilityForOperation(operation)).toBe(capability);
    expect(REMOTE_CONTROL_REQUIRED_CAPABILITY[operation]).toBe(capability);
  }
});

test("round trips validated frames through bounded UTF-8 JSON", () => {
  const parsed = parseRemoteControlFrame(request({
    operation: "session.send",
    capability: "sessions.send",
    payload: { sessionId: "task_1", text: "你好 Chili", mode: "steer" },
  }));
  const encoded = encodeRemoteControlFrame(parsed);

  expect(encoded.byteLength).toBe(remoteControlJsonBytes(parsed));
  expect(decodeRemoteControlFrame(encoded)).toEqual(parsed);
  expect(decodeRemoteControlFrame(new TextDecoder().decode(encoded))).toEqual(parsed);
});

test("rejects unknown fields, unsupported frames, and mismatched capabilities", () => {
  expect(() => parseRemoteControlFrame({ ...request(), admin: true })).toThrow(
    "frame.* contains an unsupported field",
  );
  expect(() => parseRemoteControlFrame(request({ payload: { unexpected: true } }))).toThrow(
    "frame.payload.* contains an unsupported field",
  );
  expect(() => parseRemoteControlFrame(request({ capability: "sessions.stop" }))).toThrow(
    "frame.capability must be the capability required by the operation",
  );
  expect(() => parseRemoteControlFrame(request({ version: 2 }))).toThrow("frame.version must equal 1");
  expect(() => parseRemoteControlFrame(request({ type: "event" }))).toThrow("frame.type must be one of");
  expect(() => parseRemoteControlFrame(request({ sequence: 0 }))).toThrow(
    "frame.sequence must be a positive safe integer",
  );
  expect(() => parseRemoteControlFrame(request({ sequence: REMOTE_CONTROL_LIMITS.maxSequence + 1 }))).toThrow(
    `frame.sequence must not exceed ${REMOTE_CONTROL_LIMITS.maxSequence}`,
  );
  expect(() => parseRemoteControlFrame(request({ hostId: "wrong/host" }))).toThrow(
    "frame.hostId must be a safe identifier",
  );
  expect(() => parseRemoteControlFrame(request({ requestId: "bad/request" }))).toThrow(
    "frame.requestId must be a safe identifier",
  );
  expect(() => parseRemoteControlFrame(request({ credential: "not+base64" }))).toThrow(
    "frame.credential must be a base64url token",
  );
  expect(() => parseRemoteControlFrame(Object.create(request()) as unknown)).toThrow(
    "frame must be a plain object",
  );
});

test("bounds prompts and complete frames by UTF-8 bytes", () => {
  const exactPrompt = "界".repeat(Math.floor(REMOTE_CONTROL_LIMITS.maxPromptBytes / 3));
  expect(parseRemoteControlFrame(request({
    operation: "session.send",
    capability: "sessions.send",
    payload: { sessionId: "task_1", text: exactPrompt, mode: "queue" },
  })).type).toBe("request");

  const oversizedPrompt = "界".repeat(Math.floor(REMOTE_CONTROL_LIMITS.maxPromptBytes / 3) + 1);
  expect(() => parseRemoteControlFrame(request({
    operation: "session.send",
    capability: "sessions.send",
    payload: { sessionId: "task_1", text: oversizedPrompt, mode: "queue" },
  }))).toThrow(`must not exceed ${REMOTE_CONTROL_LIMITS.maxPromptBytes} UTF-8 bytes`);

  expect(() => decodeRemoteControlFrame(new Uint8Array(REMOTE_CONTROL_LIMITS.maxFrameBytes + 1))).toThrow(
    `must not exceed ${REMOTE_CONTROL_LIMITS.maxFrameBytes} UTF-8 bytes`,
  );
});

test("validates ACK, result, bounded error, and resync invariants", () => {
  const ack = frame({
    type: "ack",
    sequence: 4,
    requestId: "request_4",
    acknowledgedSequence: 4,
  });
  expect(parseRemoteControlFrame(ack)).toMatchObject({ type: "ack", acknowledgedSequence: 4 });
  expect(() => parseRemoteControlFrame({ ...ack, acknowledgedSequence: 3 })).toThrow(
    "must equal the admitted request sequence",
  );

  expect(parseRemoteControlFrame(frame({
    type: "result",
    sequence: 4,
    requestId: "request_4",
    result: { accepted: true, position: 1 },
  }))).toMatchObject({ type: "result", result: { accepted: true, position: 1 } });

  const error = frame({
    type: "error",
    sequence: 4,
    requestId: "request_4",
    admitted: false,
    error: { code: "forbidden", message: "Capability is not granted", retryable: false },
  });
  expect(parseRemoteControlFrame(error)).toMatchObject({
    type: "error",
    admitted: false,
    error: { code: "forbidden" },
  });
  const { admitted: _admitted, ...missingAdmission } = error;
  expect(() => parseRemoteControlFrame(missingAdmission)).toThrow("frame.admitted must be a boolean");
  expect(() => parseRemoteControlFrame({ ...error, admitted: "yes" })).toThrow(
    "frame.admitted must be a boolean",
  );
  expect(parseRemoteControlFrame({ ...error, admitted: true })).toMatchObject({
    type: "error",
    admitted: true,
    sequence: 4,
  });
  expect(() => parseRemoteControlFrame({
    ...error,
    admitted: true,
    error: { code: "unavailable", message: "Try later", retryable: true },
  })).toThrow("frame.error.retryable must be false when the sequence was admitted");
  expect(() => parseRemoteControlFrame({
    ...error,
    error: { code: "forbidden", message: "unsafe\nsecret", retryable: false },
  })).toThrow("must be a single-line message");
  expect(() => parseRemoteControlFrame({
    ...error,
    error: { code: "root", message: "no", retryable: false },
  })).toThrow("frame.error.code must be one of");

  const initialResync = frame({
    type: "resync",
    acknowledgedSequence: 0,
    expectedSequence: 1,
    reason: "reconnect",
  });
  expect(parseRemoteControlFrame(initialResync)).toMatchObject({ type: "resync", expectedSequence: 1 });
  expect(() => parseRemoteControlFrame({ ...initialResync, expectedSequence: 2 })).toThrow(
    "must immediately follow the acknowledged sequence",
  );
  expect(() => parseRemoteControlFrame({
    ...initialResync,
    acknowledgedSequence: REMOTE_CONTROL_LIMITS.maxSequence,
    expectedSequence: REMOTE_CONTROL_LIMITS.maxSequence,
  })).toThrow(`must be below ${REMOTE_CONTROL_LIMITS.maxSequence} so another sequence remains`);
});

test("rejects unbounded or prototype-sensitive JSON results", () => {
  const tooManyEntries = Array.from({ length: REMOTE_CONTROL_LIMITS.maxJsonEntries + 1 }, () => null);
  expect(() => parseRemoteControlFrame(frame({
    type: "result",
    sequence: 1,
    requestId: "request_1",
    result: tooManyEntries,
  }))).toThrow(`must not exceed ${REMOTE_CONTROL_LIMITS.maxJsonEntries} entries`);

  const poisoned = JSON.parse('{"__proto__":{"admin":true}}') as unknown;
  expect(() => parseRemoteControlFrame(frame({
    type: "result",
    sequence: 1,
    requestId: "request_1",
    result: poisoned,
  }))).toThrow("must not contain a prototype-sensitive key");

  expect(() => parseRemoteControlFrame(frame({
    type: "result",
    sequence: 1,
    requestId: "request_1",
    result: Number.POSITIVE_INFINITY,
  }))).toThrow("must contain only finite numbers");
});

test("keeps stable device identity and credentials out of relay-visible envelopes", () => {
  const sourceCiphertext = Buffer.from([1, 2, 3, 4]);
  const envelope = {
    version: REMOTE_CONTROL_PROTOCOL_VERSION,
    routeId: "route_random_1",
    direction: "device_to_host",
    messageId: "message_1",
    ciphertext: sourceCiphertext,
    byteLength: sourceCiphertext.byteLength,
    createdAt: 1_725_000_000_000,
  };
  const parsed = parseOpaqueRelayEnvelope(envelope);
  sourceCiphertext[0] = 9;

  expect(parsed.ciphertext[0]).toBe(1);
  expect(Buffer.isBuffer(parsed.ciphertext)).toBe(false);
  parsed.ciphertext[1] = 8;
  expect(sourceCiphertext[1]).toBe(2);
  expect(Object.keys(parsed)).toEqual([
    "version",
    "routeId",
    "direction",
    "messageId",
    "ciphertext",
    "byteLength",
    "createdAt",
  ]);
  expect(parsed).not.toHaveProperty("deviceId");
  expect(parsed).not.toHaveProperty("credential");
  expect(parsed).not.toHaveProperty("sequence");

  expect(() => parseOpaqueRelayEnvelope({ ...envelope, deviceId: "device_1" })).toThrow(
    "envelope.* contains an unsupported field",
  );
  expect(() => parseOpaqueRelayEnvelope({ ...envelope, byteLength: 3 })).toThrow(
    "envelope.byteLength must equal the ciphertext byte length",
  );
  expect(() => parseOpaqueRelayEnvelope({
    ...envelope,
    ciphertext: new Uint8Array(REMOTE_CONTROL_LIMITS.maxCiphertextBytes + 1),
    byteLength: REMOTE_CONTROL_LIMITS.maxCiphertextBytes + 1,
  })).toThrow(`must not exceed ${REMOTE_CONTROL_LIMITS.maxCiphertextBytes} bytes`);
});

test("uses one canonical bounded route parser before relay map admission", () => {
  expect(String(parseRemoteControlRouteId("route-1:epoch_2"))).toBe("route-1:epoch_2");
  expect(() => parseRemoteControlRouteId("route/1")).toThrow("routeId must be a safe identifier");
  expect(() => parseRemoteControlRouteId("路由")).toThrow("routeId must be a safe identifier");
  expect(() => parseRemoteControlRouteId("r".repeat(REMOTE_CONTROL_LIMITS.maxRouteIdBytes + 1))).toThrow(
    "routeId must be a safe identifier",
  );
});

test("enforces message-count and complete-ciphertext byte queue admission", () => {
  expect(() => assertRemoteControlQueueAdmission({
    messages: REMOTE_CONTROL_LIMITS.maxQueueMessages - 1,
    bytes: REMOTE_CONTROL_LIMITS.maxQueueBytes - 1,
  }, 1)).not.toThrow();

  expect(() => assertRemoteControlQueueAdmission({
    messages: REMOTE_CONTROL_LIMITS.maxQueueMessages,
    bytes: 0,
  }, 1)).toThrow(`must remain below ${REMOTE_CONTROL_LIMITS.maxQueueMessages}`);

  expect(() => assertRemoteControlQueueAdmission({
    messages: 0,
    bytes: REMOTE_CONTROL_LIMITS.maxQueueBytes,
  }, 1)).toThrow(`must remain within ${REMOTE_CONTROL_LIMITS.maxQueueBytes} after admission`);

  expect(() => assertRemoteControlQueueAdmission({ messages: 0, bytes: 0 },
    REMOTE_CONTROL_LIMITS.maxCiphertextBytes + 1)).toThrow(
    `must not exceed ${REMOTE_CONTROL_LIMITS.maxCiphertextBytes}`,
  );
});

test("validation errors never reflect hostile field names or secret values", () => {
  const secret = "Bearer_SUPER_SECRET_CANARY";
  let caught: unknown;
  try {
    parseRemoteControlFrame({ ...request(), [secret]: secret });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RemoteControlProtocolError);
  expect((caught as Error).message).toBe("frame.* contains an unsupported field");
  expect((caught as Error).message).not.toContain(secret);
  expect(JSON.stringify(caught)).not.toContain(secret);
  expect(Object.keys(caught as object)).not.toContain("path");
});

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: REMOTE_CONTROL_PROTOCOL_VERSION,
    type: "request",
    hostId: "host_1",
    sessionId: "control_session_1",
    deviceId: "device_1",
    credential: "credential_token_1",
    sequence: 1,
    requestId: "request_1",
    capability: "sessions.read",
    operation: "sessions.list",
    payload: {},
    ...overrides,
  };
}

function frame(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    version: REMOTE_CONTROL_PROTOCOL_VERSION,
    hostId: "host_1",
    sessionId: "control_session_1",
    ...fields,
  };
}
