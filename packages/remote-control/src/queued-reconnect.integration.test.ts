import { expect, test } from "bun:test";

import { FakeMobileClient } from "./fake-mobile-client.js";
import { HostBridge, type RemoteControlService } from "./host-bridge.js";
import { InMemoryRelay } from "./in-memory-relay.js";
import {
  InMemoryPairingAuthority,
  createPairingProof,
  generateDeviceIdentity,
} from "./pairing-security.js";
import {
  parseOpaqueRelayEnvelope,
  parseRemoteControlFrame,
  type OpaqueRelayEnvelope,
} from "./protocol.js";

const HOST_ID = "host_queued_reconnect";
const NOW = 7_000;
const PAYLOAD = { sessionId: "session_target", text: "one side effect", mode: "queue" } as const;

for (const recoveryOrder of ["host-first", "mobile-first"] as const) {
  test(`queued request recovers after relay drain but before host admission (${recoveryOrder})`, async () => {
    const fixture = createFixture();
    const { relay, bridge, mobile, outbound, calls } = fixture;
    mobile.connect();
    const receipt = mobile.sendRequest("session.send", PAYLOAD);
    expect(receipt.status).toBe("queued");
    expect(relay.snapshot().queues.toHosts.messages).toBe(1);

    // The real relay synchronously removes the queued envelope, but the
    // bridge's asynchronous admission actor has not committed its sequence.
    bridge.connect(relay);
    bridge.disconnect();
    await bridge.whenIdle();
    expect(relay.snapshot().queues.total).toEqual({ messages: 0, bytes: 0 });
    expect(bridge.snapshot()).toMatchObject({ pendingMessages: 0, sessionStreams: 0 });
    expect(calls).toEqual([]);
    expect(mobile.receivedFrames()).toEqual([]);
    expect(mobile.snapshot()).toMatchObject({
      acknowledgedSequence: 0,
      nextSequence: 2,
      unackedSequences: [1],
      trackedRequests: 1,
    });

    mobile.disconnect();
    if (recoveryOrder === "host-first") {
      bridge.connect(relay);
      mobile.connect();
    } else {
      mobile.connect();
      bridge.connect(relay);
    }
    await bridge.whenIdle();

    expectFreshRetries(fixture, receipt, 2);
    expect(calls).toEqual([{ sequence: 1, requestId: receipt.requestId }]);
    expect(mobile.receivedFrames().map((frame) => frame.type)).toEqual(["ack", "result"]);
    expect(mobile.snapshot()).toMatchObject({
      acknowledgedSequence: 1,
      nextSequence: 2,
      unackedSequences: [],
      trackedRequests: 0,
    });
    expect(relay.snapshot().queues.total).toEqual({ messages: 0, bytes: 0 });

    // Neither an already-connected call nor a later reconnect replays a
    // settled request. A genuinely new request can advance beyond the head.
    mobile.connect();
    mobile.disconnect();
    mobile.connect();
    expect(outbound).toHaveLength(2);
    const next = mobile.sendRequest("session.send", PAYLOAD);
    expect(next.sequence).toBe(2);
    await bridge.whenIdle();
    expect(calls).toEqual([
      { sequence: 1, requestId: receipt.requestId },
      { sequence: 2, requestId: next.requestId },
    ]);
    expect(mobile.acknowledgedSequence).toBe(2);
    expect(mobile.unackedSequences).toEqual([]);
    mobile.disconnect();
    bridge.disconnect();
  });
}

test("explicit reconnect retries a still-queued request once without repeating its side effect", async () => {
  const fixture = createFixture();
  const { relay, bridge, mobile, outbound, calls } = fixture;
  mobile.connect();
  const receipt = mobile.sendRequest("session.send", PAYLOAD);
  expect(receipt.status).toBe("queued");

  for (let expectedEnvelopes = 2; expectedEnvelopes <= 3; expectedEnvelopes += 1) {
    mobile.disconnect();
    mobile.connect();
    expectFreshRetries(fixture, receipt, expectedEnvelopes);
    expect(relay.snapshot().queues.toHosts.messages).toBe(expectedEnvelopes);
    mobile.connect();
    expect(outbound).toHaveLength(expectedEnvelopes);
    expect(calls).toEqual([]);
  }

  // All three real ciphertexts reach the same bridge. Only the original
  // sequence may invoke the side-effecting operation; later copies resync.
  bridge.connect(relay);
  await bridge.whenIdle();
  expect(calls).toEqual([{ sequence: 1, requestId: receipt.requestId }]);
  expect(mobile.receivedFrames().map((frame) => frame.type))
    .toEqual(["ack", "result", "resync", "resync"]);
  expect(mobile.snapshot()).toMatchObject({
    acknowledgedSequence: 1,
    unackedSequences: [],
    trackedRequests: 0,
  });
  expect(relay.snapshot().queues.total).toEqual({ messages: 0, bytes: 0 });
  mobile.disconnect();
  mobile.connect();
  await bridge.whenIdle();
  expect(outbound).toHaveLength(3);
  expect(calls).toHaveLength(1);
  mobile.disconnect();
  bridge.disconnect();
});

function createFixture() {
  const authority = new InMemoryPairingAuthority({
    hostId: HOST_ID,
    allowedCapabilities: ["sessions.send"],
    clock: () => NOW,
  });
  const identity = generateDeviceIdentity();
  const challenge = authority.beginPairing({
    deviceId: identity.deviceId,
    publicKey: identity.publicKey,
    grantedCapabilities: ["sessions.send"],
  });
  const pairing = authority.completePairing(createPairingProof(challenge, identity.privateKey));
  const relay = new InMemoryRelay();
  const outbound: OpaqueRelayEnvelope[] = [];
  const connectDevice = relay.connectDevice.bind(relay);
  // Observe only: every send, queue, drain, and connection still uses the real
  // InMemoryRelay implementation, not a fake transport or manual frame reply.
  relay.connectDevice = (options) => {
    const connection = connectDevice(options);
    return {
      get connected() { return connection.connected; },
      routeId: connection.routeId,
      send: (envelope) => {
        outbound.push(parseOpaqueRelayEnvelope(envelope));
        return connection.send(envelope);
      },
      disconnect: () => connection.disconnect(),
    };
  };
  const calls: { sequence: number; requestId: string }[] = [];
  const service: RemoteControlService = {
    invoke: (request, context) => {
      expect(request.operation).toBe("session.send");
      expect(request.payload).toEqual(PAYLOAD);
      calls.push({ sequence: context.sequence, requestId: context.requestId });
      return { accepted: true };
    },
  };
  const bridge = new HostBridge({
    hostId: HOST_ID,
    routeId: pairing.channel.routeId,
    controlService: service,
    credentials: authority,
    codec: authority,
    now: () => NOW,
  });
  let requestId = 0;
  let messageId = 0;
  const mobile = new FakeMobileClient({
    relay,
    identity,
    pairing,
    hostId: HOST_ID,
    sessionId: "control_queued_reconnect",
    clock: () => NOW,
    requestIdFactory: () => `request_queued_reconnect_${++requestId}`,
    messageIdFactory: () => `message_queued_reconnect_${++messageId}`,
  });
  return { authority, relay, bridge, mobile, outbound, calls };
}

function expectFreshRetries(
  fixture: ReturnType<typeof createFixture>,
  receipt: { sequence: number; requestId: string },
  expectedCount: number,
): void {
  expect(fixture.outbound).toHaveLength(expectedCount);
  expect(new Set(fixture.outbound.map((envelope) => envelope.messageId)).size).toBe(expectedCount);
  expect(new Set(fixture.outbound.map((envelope) => Buffer.from(envelope.ciphertext).toString("hex"))).size)
    .toBe(expectedCount);
  for (const envelope of fixture.outbound) {
    const frame = parseRemoteControlFrame(fixture.authority.openRelayEnvelope<unknown>(envelope, {
      expectedDirection: "device_to_host",
    }));
    expect(frame).toMatchObject({
      type: "request",
      sequence: receipt.sequence,
      requestId: receipt.requestId,
      operation: "session.send",
      payload: PAYLOAD,
    });
  }
}
