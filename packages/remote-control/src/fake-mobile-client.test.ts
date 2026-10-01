import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";

import {
  FakeMobileClient,
  FakeMobileClientError,
} from "./fake-mobile-client.js";
import { InMemoryRelay } from "./in-memory-relay.js";
import {
  InMemoryPairingAuthority,
  createPairingProof,
  createRelayChannelKey,
  generateDeviceIdentity,
  sealRelayEnvelope,
  type DeviceIdentity,
  type PairingChallenge,
  type PairingGrant,
  type RandomBytesSource,
} from "./pairing-security.js";
import {
  REMOTE_CONTROL_PROTOCOL_VERSION,
  parseOpaqueRelayEnvelope,
  parseRemoteControlFrame,
  type OpaqueRelayEnvelope,
  type RemoteControlErrorCode,
} from "./protocol.js";

const HOST_ID = "host_fake_mobile_attacks";
const SESSION_ID = "control_session_fake_mobile_attacks";
const NOW = 42_000;

interface Fixture {
  authority: InMemoryPairingAuthority;
  challenge: PairingChallenge;
  device: DeviceIdentity;
  grant: PairingGrant;
  relay: InMemoryRelay;
  mobile: FakeMobileClient;
}

interface Receipt {
  sequence: number;
  requestId: string;
}

type HostFrame = Record<string, unknown>;

describe("FakeMobileClient authenticated host response state machine", () => {
  test("rejects tampering and correlation attacks without advancing pending state", () => {
    const fixture = createFixture();
    const first = sendReadRequest(fixture.mobile, 1);
    const future = { sequence: 2, requestId: "request_future_ack" };

    const authenticAck = sealHostFrame(
      fixture,
      ackFrame(fixture.mobile, first),
      "tamper_source",
    );
    const tamperedCiphertext = Uint8Array.from(authenticAck.ciphertext);
    tamperedCiphertext[tamperedCiphertext.byteLength - 1] =
      (tamperedCiphertext[tamperedCiphertext.byteLength - 1] ?? 0) ^ 1;
    const tampered = parseOpaqueRelayEnvelope({
      ...authenticAck,
      ciphertext: tamperedCiphertext,
    });

    expectRejectedWithoutProgress(
      fixture.mobile,
      tampered,
      "RELAY_DECRYPTION_FAILED",
    );
    expectRejectedWithoutProgress(
      fixture.mobile,
      sealHostFrame(fixture, {
        ...ackFrame(fixture.mobile, first),
        hostId: "host_attacker",
      }, "wrong_host"),
      "HOST_MISMATCH",
    );
    expectRejectedWithoutProgress(
      fixture.mobile,
      sealHostFrame(fixture, {
        ...ackFrame(fixture.mobile, first),
        sessionId: "control_session_attacker",
      }, "wrong_session"),
      "SESSION_MISMATCH",
    );
    expectRejectedWithoutProgress(
      fixture.mobile,
      sealHostFrame(fixture, {
        ...ackFrame(fixture.mobile, first),
        requestId: "request_forged",
      }, "wrong_request_id"),
      "RESPONSE_CORRELATION_MISMATCH",
    );
    expectRejectedWithoutProgress(
      fixture.mobile,
      sealHostFrame(fixture, resultFrame(fixture.mobile, {
        sequence: 2,
        requestId: first.requestId,
      }), "wrong_sequence"),
      "RESPONSE_NOT_PENDING",
    );
    expectRejectedWithoutProgress(
      fixture.mobile,
      sealHostFrame(fixture, ackFrame(fixture.mobile, future), "future_ack"),
      "RESPONSE_NOT_PENDING",
    );
    expectRejectedWithoutProgress(
      fixture.mobile,
      sealHostFrame(fixture, resultFrame(fixture.mobile, first), "result_before_ack"),
      "RESULT_BEFORE_ACK",
    );

    expect(progressionState(fixture.mobile)).toEqual({
      streamTerminated: false,
      acknowledgedSequence: 0,
      nextSequence: 2,
      unackedSequences: [1],
      trackedRequests: 1,
      receivedFrames: 0,
      outcomeUnknownSequences: [],
    });
  });

  test("rejects replayed, duplicate, and stale ACKs while valid ACK and result complete", () => {
    const fixture = createFixture();
    const first = sendReadRequest(fixture.mobile, 1);
    const firstAck = sealHostFrame(
      fixture,
      ackFrame(fixture.mobile, first),
      "valid_ack_1",
    );

    expect(fixture.mobile.acceptEnvelope(firstAck)).toBe(true);
    // Admission, not service completion, releases stop-and-wait.
    const second = sendReadRequest(fixture.mobile, 2);
    expect(progressionState(fixture.mobile)).toEqual({
      streamTerminated: false,
      acknowledgedSequence: 1,
      nextSequence: 3,
      unackedSequences: [2],
      trackedRequests: 2,
      receivedFrames: 1,
      outcomeUnknownSequences: [],
    });

    // Transport replay and a freshly encrypted protocol duplicate exercise
    // different guards and must both leave the admitted request untouched.
    expectRejectedWithoutProgress(
      fixture.mobile,
      firstAck,
      "RELAY_REPLAYED",
    );
    expectRejectedWithoutProgress(
      fixture.mobile,
      sealHostFrame(fixture, ackFrame(fixture.mobile, first), "duplicate_ack_1"),
      "ACK_STALE_OR_FUTURE",
    );

    expect(fixture.mobile.acceptEnvelope(sealHostFrame(
      fixture,
      resultFrame(fixture.mobile, first),
      "valid_result_1",
    ))).toBe(true);
    expect(progressionState(fixture.mobile)).toEqual({
      streamTerminated: false,
      acknowledgedSequence: 1,
      nextSequence: 3,
      unackedSequences: [2],
      trackedRequests: 1,
      receivedFrames: 2,
      outcomeUnknownSequences: [],
    });

    expectRejectedWithoutProgress(
      fixture.mobile,
      sealHostFrame(fixture, ackFrame(fixture.mobile, first), "stale_ack_1"),
      "RESPONSE_NOT_PENDING",
    );

    expect(fixture.mobile.acceptEnvelope(sealHostFrame(
      fixture,
      ackFrame(fixture.mobile, second),
      "valid_ack_2",
    ))).toBe(true);
    expect(fixture.mobile.acceptEnvelope(sealHostFrame(
      fixture,
      resultFrame(fixture.mobile, second),
      "valid_result_2",
    ))).toBe(true);
    expect(progressionState(fixture.mobile)).toEqual({
      streamTerminated: false,
      acknowledgedSequence: 2,
      nextSequence: 3,
      unackedSequences: [],
      trackedRequests: 0,
      receivedFrames: 4,
      outcomeUnknownSequences: [],
    });
    expect(fixture.mobile.receivedFrames().map((frame) => frame.type)).toEqual([
      "ack",
      "result",
      "ack",
      "result",
    ]);
  });

  test("rejects forged, regressive, and future resync without changing high-water state", () => {
    const fixture = createFixture();
    const first = sendReadRequest(fixture.mobile, 1);

    expect(fixture.mobile.acceptEnvelope(sealHostFrame(
      fixture,
      ackFrame(fixture.mobile, first),
      "resync_setup_ack",
    ))).toBe(true);
    expect(fixture.mobile.acceptEnvelope(sealHostFrame(
      fixture,
      resultFrame(fixture.mobile, first),
      "resync_setup_result",
    ))).toBe(true);
    sendReadRequest(fixture.mobile, 2);

    const forgedChannel = createRelayChannelKey({
      hostId: HOST_ID,
      routeId: fixture.grant.channel.routeId,
      randomBytes: deterministicRandom("forged-channel"),
    });
    const forgedResync = parseOpaqueRelayEnvelope(sealRelayEnvelope(
      forgedChannel,
      "host_to_device",
      resyncFrame(fixture.mobile, 1),
      {
        clock: () => NOW,
        messageId: "message_host_forged_resync",
        randomBytes: deterministicRandom("forged-resync-envelope"),
      },
    ));
    expectRejectedWithoutProgress(
      fixture.mobile,
      forgedResync,
      "RELAY_DECRYPTION_FAILED",
    );
    expectRejectedWithoutProgress(
      fixture.mobile,
      sealHostFrame(fixture, resyncFrame(fixture.mobile, 0), "regressive_resync"),
      "RESYNC_ACK_REGRESSION",
    );
    expectRejectedWithoutProgress(
      fixture.mobile,
      sealHostFrame(fixture, resyncFrame(fixture.mobile, 3), "future_resync"),
      "RESYNC_FUTURE_ACK",
    );

    expect(progressionState(fixture.mobile)).toEqual({
      streamTerminated: false,
      acknowledgedSequence: 1,
      nextSequence: 3,
      unackedSequences: [2],
      trackedRequests: 1,
      receivedFrames: 2,
      outcomeUnknownSequences: [],
    });
  });

  test("uses admitted errors as terminal ACK evidence and rejects stale or future errors atomically", () => {
    const fixture = createFixture();
    const first = sendReadRequest(fixture.mobile, 1);

    // The ACK was lost, but the authenticated error proves the host committed
    // sequence 1. It must advance and settle in one accepted transition.
    expect(fixture.mobile.acceptEnvelope(sealHostFrame(
      fixture,
      errorFrame(fixture.mobile, first, {
        admitted: true,
        retryable: false,
        code: "request_failed",
      }),
      "admitted_error_without_ack",
    ))).toBe(true);
    expect(progressionState(fixture.mobile)).toEqual({
      streamTerminated: false,
      acknowledgedSequence: 1,
      nextSequence: 2,
      unackedSequences: [],
      trackedRequests: 0,
      receivedFrames: 1,
      outcomeUnknownSequences: [],
    });

    const second = sendReadRequest(fixture.mobile, 2);
    const future = { sequence: 3, requestId: "request_future_error" };
    expectRejectedWithoutProgress(
      fixture.mobile,
      sealHostFrame(fixture, errorFrame(fixture.mobile, future, {
        admitted: true,
        retryable: false,
        code: "request_failed",
      }), "future_admitted_error"),
      "RESPONSE_NOT_PENDING",
    );

    expect(fixture.mobile.acceptEnvelope(sealHostFrame(
      fixture,
      ackFrame(fixture.mobile, second),
      "ack_before_admitted_error",
    ))).toBe(true);
    const third = sendReadRequest(fixture.mobile, 3);
    expectRejectedWithoutProgress(
      fixture.mobile,
      sealHostFrame(fixture, errorFrame(fixture.mobile, second, {
        admitted: false,
        retryable: true,
        code: "unavailable",
      }), "error_cannot_retract_ack"),
      "ERROR_STALE_OR_FUTURE",
    );
    expect(fixture.mobile.acceptEnvelope(sealHostFrame(
      fixture,
      errorFrame(fixture.mobile, second, {
        admitted: true,
        // Protocol requires an admitted terminal error to be non-retryable.
        retryable: false,
        code: "request_failed",
      }),
      "admitted_error_after_ack",
    ))).toBe(true);

    expectRejectedWithoutProgress(
      fixture.mobile,
      sealHostFrame(fixture, errorFrame(fixture.mobile, first, {
        admitted: true,
        retryable: false,
        code: "request_failed",
      }), "stale_admitted_error"),
      "RESPONSE_NOT_PENDING",
    );
    expect(progressionState(fixture.mobile)).toEqual({
      streamTerminated: false,
      acknowledgedSequence: 2,
      nextSequence: 4,
      unackedSequences: [3],
      trackedRequests: 1,
      receivedFrames: 3,
      outcomeUnknownSequences: [],
    });
  });

  test("retains an unadmitted retryable error at the same sequence across reconnect", () => {
    const fixture = createFixture();
    const outbound: OpaqueRelayEnvelope[] = [];
    fixture.relay.connectHost({
      routeId: fixture.grant.channel.routeId,
      onMessage: (envelope) => {
        outbound.push(envelope);
      },
    });
    fixture.mobile.connect();
    const first = sendReadRequest(fixture.mobile, 1);
    expect(outbound).toHaveLength(1);

    expect(fixture.mobile.acceptEnvelope(sealHostFrame(
      fixture,
      errorFrame(fixture.mobile, first, {
        admitted: false,
        retryable: true,
        code: "unavailable",
      }),
      "unadmitted_retryable_error",
    ))).toBe(true);
    expect(progressionState(fixture.mobile)).toEqual({
      streamTerminated: false,
      acknowledgedSequence: 0,
      nextSequence: 2,
      unackedSequences: [1],
      trackedRequests: 1,
      receivedFrames: 1,
      outcomeUnknownSequences: [],
    });
    expectSendRejectedWithoutProgress(fixture.mobile, "ADMISSION_PENDING");

    fixture.mobile.disconnect();
    fixture.mobile.connect();
    expect(outbound).toHaveLength(2);
    expect(outbound[0]?.messageId).not.toBe(outbound[1]?.messageId);
    const retriedFrames = outbound.map((envelope) => parseRemoteControlFrame(
      fixture.authority.openRelayEnvelope<unknown>(envelope, {
        expectedDirection: "device_to_host",
      }),
    ));
    expect(retriedFrames).toHaveLength(2);
    for (const frame of retriedFrames) {
      expect(frame).toMatchObject({
        type: "request",
        sequence: first.sequence,
        requestId: first.requestId,
      });
    }

    // Resync is state-only on the inbound callback stack. Even repeated
    // authenticated frames cannot recursively retransmit or grow outbound.
    for (let index = 1; index <= 3; index += 1) {
      expect(fixture.mobile.acceptEnvelope(sealHostFrame(
        fixture,
        resyncFrame(fixture.mobile, 0),
        `bounded_retry_resync_${index}`,
      ))).toBe(true);
      expect(outbound).toHaveLength(2);
    }
    expectSendRejectedWithoutProgress(fixture.mobile, "ADMISSION_PENDING");

    fixture.mobile.disconnect();
    fixture.mobile.connect();
    expect(outbound).toHaveLength(3);
    const lastRetry = parseRemoteControlFrame(
      fixture.authority.openRelayEnvelope<unknown>(outbound[2], {
        expectedDirection: "device_to_host",
      }),
    );
    expect(lastRetry).toMatchObject({
      type: "request",
      sequence: first.sequence,
      requestId: first.requestId,
    });
    expect(progressionState(fixture.mobile)).toEqual({
      streamTerminated: false,
      acknowledgedSequence: 0,
      nextSequence: 2,
      unackedSequences: [1],
      trackedRequests: 1,
      receivedFrames: 4,
      outcomeUnknownSequences: [],
    });
  });

  test("fails closed on an unadmitted non-retryable error without a hidden gap", () => {
    const fixture = createFixture();
    const first = sendReadRequest(fixture.mobile, 1);

    expect(fixture.mobile.acceptEnvelope(sealHostFrame(
      fixture,
      errorFrame(fixture.mobile, first, {
        admitted: false,
        retryable: false,
        code: "credential_revoked",
      }),
      "unadmitted_fatal_error",
    ))).toBe(true);
    expect(progressionState(fixture.mobile)).toEqual({
      streamTerminated: true,
      acknowledgedSequence: 0,
      nextSequence: 2,
      unackedSequences: [],
      trackedRequests: 0,
      receivedFrames: 1,
      outcomeUnknownSequences: [],
    });

    const beforeRejectedSend = progressionState(fixture.mobile);
    let thrown: unknown;
    try {
      fixture.mobile.sendRequest("sessions.list", { status: "active" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(FakeMobileClientError);
    expect((thrown as FakeMobileClientError).code).toBe("STREAM_TERMINATED");
    expect(progressionState(fixture.mobile)).toEqual(beforeRejectedSend);

    const outbound: OpaqueRelayEnvelope[] = [];
    fixture.relay.connectHost({
      routeId: fixture.grant.channel.routeId,
      onMessage: (envelope) => {
        outbound.push(envelope);
      },
    });
    fixture.mobile.connect();
    expect(outbound).toEqual([]);
    const diagnostics = JSON.stringify(fixture.mobile.snapshot());
    expect(diagnostics).not.toContain("credential_revoked");
    expect(allKeys(fixture.mobile.snapshot())).not.toContain("error");
  });

  test("keeps secrets and stable routing identity out of relay and client snapshots", () => {
    const fixture = createFixture();
    let relayVisible: OpaqueRelayEnvelope | undefined;
    fixture.relay.connectHost({
      routeId: fixture.grant.channel.routeId,
      onMessage: (envelope) => {
        relayVisible = envelope;
      },
    });
    fixture.mobile.connect();
    sendReadRequest(fixture.mobile, 1);

    if (relayVisible === undefined) {
      throw new Error("expected the connected relay to observe one opaque envelope");
    }
    expect(Object.keys(relayVisible).sort()).toEqual([
      "byteLength",
      "ciphertext",
      "createdAt",
      "direction",
      "messageId",
      "routeId",
      "version",
    ]);
    for (const forbiddenField of [
      "credential",
      "channel",
      "key",
      "deviceId",
      "hostId",
      "sessionId",
      "sequence",
      "requestId",
      "capability",
      "operation",
      "payload",
    ]) {
      expect(forbiddenField in relayVisible).toBe(false);
    }

    const relaySnapshot = fixture.relay.snapshot();
    const clientSnapshot = fixture.mobile.snapshot();
    expect(relaySnapshot.connections).toEqual({ hosts: 1, devices: 1 });
    expect(clientSnapshot).toMatchObject({
      connected: true,
      streamTerminated: false,
      acknowledgedSequence: 0,
      nextSequence: 2,
      trackedRequests: 1,
    });
    for (const snapshot of [relaySnapshot, clientSnapshot]) {
      const diagnostics = JSON.stringify(snapshot);
      for (const secret of [
        fixture.grant.credential,
        fixture.grant.channel.key,
        fixture.device.deviceId,
        fixture.grant.channel.routeId,
        fixture.challenge.nonce,
      ]) {
        expect(diagnostics).not.toContain(secret);
      }
      for (const forbiddenKey of ["credential", "channel", "deviceId", "routeId"]) {
        expect(allKeys(snapshot)).not.toContain(forbiddenKey);
      }
    }
  });
});

function createFixture(): Fixture {
  const authority = new InMemoryPairingAuthority({
    hostId: HOST_ID,
    allowedCapabilities: ["sessions.read"],
    clock: () => NOW,
    randomBytes: deterministicRandom("fake-mobile-pairing"),
  });
  const device = generateDeviceIdentity();
  const challenge = authority.beginPairing({
    deviceId: device.deviceId,
    publicKey: device.publicKey,
    grantedCapabilities: ["sessions.read"],
  });
  const grant = authority.completePairing(
    createPairingProof(challenge, device.privateKey),
  );
  const relay = new InMemoryRelay();
  let requestIndex = 0;
  let outboundMessageIndex = 0;
  const mobile = new FakeMobileClient({
    relay,
    identity: device,
    pairing: grant,
    hostId: HOST_ID,
    sessionId: SESSION_ID,
    clock: () => NOW,
    requestIdFactory: () => `request_mobile_${++requestIndex}`,
    messageIdFactory: () => `message_mobile_${++outboundMessageIndex}`,
  });
  return { authority, challenge, device, grant, relay, mobile };
}

function sendReadRequest(mobile: FakeMobileClient, expectedSequence: number): Receipt {
  const receipt = mobile.sendRequest("sessions.list", { status: "active" });
  expect(receipt.sequence).toBe(expectedSequence);
  return receipt;
}

function ackFrame(mobile: FakeMobileClient, receipt: Receipt): HostFrame {
  return {
    version: REMOTE_CONTROL_PROTOCOL_VERSION,
    type: "ack",
    hostId: mobile.hostId,
    sessionId: mobile.sessionId,
    sequence: receipt.sequence,
    requestId: receipt.requestId,
    acknowledgedSequence: receipt.sequence,
  };
}

function resultFrame(mobile: FakeMobileClient, receipt: Receipt): HostFrame {
  return {
    version: REMOTE_CONTROL_PROTOCOL_VERSION,
    type: "result",
    hostId: mobile.hostId,
    sessionId: mobile.sessionId,
    sequence: receipt.sequence,
    requestId: receipt.requestId,
    result: { accepted: true },
  };
}

function errorFrame(
  mobile: FakeMobileClient,
  receipt: Receipt,
  options: {
    admitted: boolean;
    retryable: boolean;
    code: RemoteControlErrorCode;
  },
): HostFrame {
  return {
    version: REMOTE_CONTROL_PROTOCOL_VERSION,
    type: "error",
    hostId: mobile.hostId,
    sessionId: mobile.sessionId,
    sequence: receipt.sequence,
    requestId: receipt.requestId,
    admitted: options.admitted,
    error: {
      code: options.code,
      message: "Remote request failed",
      retryable: options.retryable,
    },
  };
}

function resyncFrame(mobile: FakeMobileClient, acknowledgedSequence: number): HostFrame {
  return {
    version: REMOTE_CONTROL_PROTOCOL_VERSION,
    type: "resync",
    hostId: mobile.hostId,
    sessionId: mobile.sessionId,
    acknowledgedSequence,
    expectedSequence: acknowledgedSequence + 1,
    reason: "reconnect",
  };
}

function sealHostFrame(
  fixture: Fixture,
  frame: HostFrame,
  label: string,
): OpaqueRelayEnvelope {
  return parseOpaqueRelayEnvelope(fixture.authority.sealRelayEnvelope(
    fixture.grant.channel.routeId,
    "host_to_device",
    frame,
    {
      clock: () => NOW,
      messageId: `message_host_${label}`,
    },
  ));
}

function progressionState(mobile: FakeMobileClient): {
  streamTerminated: boolean;
  acknowledgedSequence: number;
  nextSequence: number;
  unackedSequences: readonly number[];
  trackedRequests: number;
  receivedFrames: number;
  outcomeUnknownSequences: readonly number[];
} {
  const snapshot = mobile.snapshot();
  return {
    streamTerminated: snapshot.streamTerminated,
    acknowledgedSequence: snapshot.acknowledgedSequence,
    nextSequence: snapshot.nextSequence,
    unackedSequences: [...snapshot.unackedSequences],
    trackedRequests: snapshot.trackedRequests,
    receivedFrames: snapshot.receivedFrames,
    outcomeUnknownSequences: [...snapshot.outcomeUnknownSequences],
  };
}

function expectRejectedWithoutProgress(
  mobile: FakeMobileClient,
  envelope: OpaqueRelayEnvelope,
  expectedCode: string,
): void {
  const before = progressionState(mobile);
  expect(mobile.acceptEnvelope(envelope)).toBe(false);
  expect(progressionState(mobile)).toEqual(before);
  expect(mobile.snapshot().lastInboundErrorCode).toBe(expectedCode);
}

function expectSendRejectedWithoutProgress(
  mobile: FakeMobileClient,
  expectedCode: "ADMISSION_PENDING" | "STREAM_TERMINATED",
): void {
  const before = progressionState(mobile);
  let thrown: unknown;
  try {
    mobile.sendRequest("sessions.list", { status: "active" });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(FakeMobileClientError);
  expect((thrown as FakeMobileClientError).code).toBe(expectedCode);
  expect(progressionState(mobile)).toEqual(before);
}

function allKeys(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  return Object.entries(record).flatMap(([key, entry]) => [key, ...allKeys(entry)]);
}

function deterministicRandom(seed: string): RandomBytesSource {
  let counter = 0;
  return (size) => {
    const output = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const block = createHash("sha256")
        .update(seed)
        .update(String(counter))
        .digest();
      counter += 1;
      offset += block.copy(output, offset, 0, Math.min(block.length, size - offset));
    }
    return output;
  };
}
