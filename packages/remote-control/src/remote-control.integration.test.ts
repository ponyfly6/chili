import { expect, test } from "bun:test";
import { FakeMobileClient } from "./fake-mobile-client.js";
import {
  HostBridge,
  type RemoteControlService,
} from "./host-bridge.js";
import {
  InMemoryRelay,
  RelayConnectionError,
  RelayLimitError,
  type RelayConnectionErrorCode,
  type RelayLimitErrorCode,
} from "./in-memory-relay.js";
import { MockControlService } from "./mock-control-service.js";
import {
  InMemoryPairingAuthority,
  PairingSecurityError,
  RelayReplayGuard,
  createPairingProof,
  generateDeviceIdentity,
  hashCredential,
  openRelayEnvelope,
  sealRelayEnvelope,
  type PairingChallenge,
  type PairingGrant,
  type PairingSecurityErrorCode,
} from "./pairing-security.js";
import {
  REMOTE_CONTROL_PROTOCOL_VERSION,
  parseOpaqueRelayEnvelope,
  parseRemoteControlFrame,
  type OpaqueRelayEnvelope,
  type RemoteControlCapability,
  type RemoteControlFrame,
  type RemoteControlRequestFrame,
} from "./protocol.js";

const HOST_ID = "host_integration";

test("pairing is one-time and credentials are hashed, bound, scoped, expiring, and revocable", async () => {
  let now = 1_000;
  const authority = new InMemoryPairingAuthority({
    hostId: HOST_ID,
    allowedCapabilities: ["sessions.read"],
    clock: () => now,
    pairingNonceTtlMs: 50,
    credentialTtlMs: 100,
  });
  const device = generateDeviceIdentity();
  const attacker = generateDeviceIdentity();
  const challenge = authority.beginPairing({
    deviceId: device.deviceId,
    publicKey: device.publicKey,
    grantedCapabilities: ["sessions.read"],
  });

  expectPairingError(
    () => authority.completePairing(createPairingProof(challenge, attacker.privateKey)),
    "PAIRING_PROOF_INVALID",
  );

  const proof = createPairingProof(challenge, device.privateKey);
  const pairingAttempts = await Promise.allSettled([
    Promise.resolve().then(() => authority.completePairing(proof)),
    Promise.resolve().then(() => authority.completePairing(proof)),
  ]);
  const successfulPairings = pairingAttempts.filter(
    (attempt): attempt is PromiseFulfilledResult<PairingGrant> => attempt.status === "fulfilled",
  );
  const rejectedPairings = pairingAttempts.filter(
    (attempt): attempt is PromiseRejectedResult => attempt.status === "rejected",
  );
  expect(successfulPairings).toHaveLength(1);
  expect(rejectedPairings).toHaveLength(1);
  expect(rejectedPairings[0]?.reason).toBeInstanceOf(PairingSecurityError);
  expect((rejectedPairings[0]?.reason as PairingSecurityError).code).toBe("PAIRING_NONCE_REUSED");
  const grant = successfulPairings[0]?.value;
  if (grant === undefined) throw new Error("pairing grant missing");

  const records = authority.credentialStore.snapshot();
  expect(records).toHaveLength(1);
  const record = records[0];
  expect(record).toBeDefined();
  if (record === undefined) throw new Error("credential record missing");
  expect(record.credentialHash).toBe(hashCredential(grant.credential, record.credentialSalt));

  const storedDiagnostics = JSON.stringify(records);
  expect(storedDiagnostics).not.toContain(grant.credential);
  expect(storedDiagnostics).not.toContain(challenge.nonce);
  expect(storedDiagnostics).not.toContain(device.privateKey);

  expect(authority.authenticate({
    credential: grant.credential,
    hostId: HOST_ID,
    deviceId: device.deviceId,
    routeId: grant.channel.routeId,
    capability: "sessions.read",
  })).toMatchObject({
    deviceId: device.deviceId,
    routeId: grant.channel.routeId,
    capabilities: ["sessions.read"],
  });

  expectPairingError(() => authority.authenticate({
    credential: mutateBearer(grant.credential),
    hostId: HOST_ID,
    deviceId: device.deviceId,
    routeId: grant.channel.routeId,
    capability: "sessions.read",
  }), "CREDENTIAL_INVALID");
  expectPairingError(() => authority.authenticate({
    credential: grant.credential,
    hostId: HOST_ID,
    deviceId: attacker.deviceId,
    routeId: grant.channel.routeId,
    capability: "sessions.read",
  }), "DEVICE_MISMATCH");
  expectPairingError(() => authority.authenticate({
    credential: grant.credential,
    hostId: HOST_ID,
    deviceId: device.deviceId,
    routeId: grant.channel.routeId,
    capability: "sessions.stop",
  }), "CAPABILITY_DENIED");

  expect(authority.revokeCredential(grant.credential)).toBe(true);
  expectPairingError(() => authority.authenticate({
    credential: grant.credential,
    hostId: HOST_ID,
    deviceId: device.deviceId,
    routeId: grant.channel.routeId,
    capability: "sessions.read",
  }), "CREDENTIAL_REVOKED");

  const expiring = pairReadOnlyDevice({ clock: () => now, credentialTtlMs: 10 });
  now = expiring.grant.expiresAt;
  expectPairingError(() => expiring.authority.authenticate({
    credential: expiring.grant.credential,
    hostId: HOST_ID,
    deviceId: expiring.device.deviceId,
    routeId: expiring.grant.channel.routeId,
    capability: "sessions.read",
  }), "CREDENTIAL_EXPIRED");

  const expiredChallenge = authority.beginPairing({
    deviceId: attacker.deviceId,
    publicKey: attacker.publicKey,
    grantedCapabilities: ["sessions.read"],
  });
  now = expiredChallenge.expiresAt;
  expectPairingError(
    () => authority.completePairing(createPairingProof(expiredChallenge, attacker.privateKey)),
    "PAIRING_NONCE_EXPIRED",
  );
});

test("relay ciphertext is opaque, replay-protected, bounded, and drains after reconnect", () => {
  const fixture = pairReadOnlyDevice({ clock: () => 2_000 });
  const sensitivePayload = "relay-must-never-see-this-prompt";
  const firstSealed = sealRelayEnvelope(
    fixture.grant.channel,
    "device_to_host",
    { credential: fixture.grant.credential, payload: sensitivePayload },
    { createdAt: 2_000, messageId: "message_integration_1" },
  );
  const secondSealed = sealRelayEnvelope(
    fixture.grant.channel,
    "device_to_host",
    { credential: fixture.grant.credential, payload: "second" },
    { createdAt: 2_001, messageId: "message_integration_2" },
  );
  const first = parseOpaqueRelayEnvelope(firstSealed);
  const second = parseOpaqueRelayEnvelope(secondSealed);

  const relayVisibleEnvelope = JSON.stringify(firstSealed);
  expect(relayVisibleEnvelope).not.toContain(fixture.grant.credential);
  expect(relayVisibleEnvelope).not.toContain(fixture.device.deviceId);
  expect(relayVisibleEnvelope).not.toContain(sensitivePayload);
  expect(Buffer.from(first.ciphertext).includes(Buffer.from(sensitivePayload, "utf8"))).toBe(false);

  const replayGuard = new RelayReplayGuard();
  expect(openRelayEnvelope(fixture.grant.channel, first, {
    expectedDirection: "device_to_host",
    replayGuard,
  })).toMatchObject({ payload: sensitivePayload });
  expectPairingError(() => openRelayEnvelope(fixture.grant.channel, first, {
    expectedDirection: "device_to_host",
    replayGuard,
  }), "RELAY_REPLAYED");

  const tampered = {
    ...first,
    ciphertext: Uint8Array.from(first.ciphertext),
  };
  tampered.ciphertext[12] = (tampered.ciphertext[12] ?? 0) ^ 1;
  expectPairingError(
    () => openRelayEnvelope(fixture.grant.channel, tampered, {
      expectedDirection: "device_to_host",
    }),
    "RELAY_DECRYPTION_FAILED",
  );

  const relay = new InMemoryRelay({
    maxMessageBytes: first.byteLength,
    maxQueuedMessages: 2,
    maxQueuedBytes: first.byteLength * 2,
    maxQueuedMessagesPerRoute: 1,
    maxQueuedBytesPerRoute: first.byteLength,
  });
  const deviceConnection = relay.connectDevice({
    routeId: fixture.grant.channel.routeId,
    onMessage: () => undefined,
  });

  const queuedFirstByte = first.ciphertext[0];
  if (queuedFirstByte === undefined) throw new Error("ciphertext is empty");
  expect(deviceConnection.send(first)).toEqual({ status: "queued" });
  first.ciphertext[0] = queuedFirstByte ^ 1;
  expect(relay.snapshot().queues.toHosts).toEqual({
    messages: 1,
    bytes: first.byteLength,
  });
  expectRelayError(() => deviceConnection.send(second), "route_queue_messages_exceeded");

  const oversized = parseOpaqueRelayEnvelope({
    ...second,
    messageId: "message_integration_oversized",
    ciphertext: new Uint8Array(first.byteLength + 1),
    byteLength: first.byteLength + 1,
  });
  expectRelayError(() => deviceConnection.send(oversized), "message_too_large");
  expect(relay.snapshot().queues.total.messages).toBe(1);

  const relaySnapshot = JSON.stringify(relay.snapshot());
  for (const secret of [
    fixture.grant.credential,
    fixture.challenge.nonce,
    fixture.grant.channel.key,
    fixture.grant.channel.routeId,
    fixture.device.deviceId,
    sensitivePayload,
  ]) {
    expect(relaySnapshot).not.toContain(secret);
  }

  const delivered: OpaqueRelayEnvelope[] = [];
  const hostConnection = relay.connectHost({
    routeId: fixture.grant.channel.routeId,
    onMessage: (envelope) => delivered.push(envelope),
  });
  expect(delivered).toHaveLength(1);
  expect(delivered[0]?.ciphertext[0]).toBe(queuedFirstByte);
  expect(relay.snapshot().queues.total).toEqual({ messages: 0, bytes: 0 });

  hostConnection.disconnect();
  expect(deviceConnection.send(second)).toEqual({ status: "queued" });
  relay.connectHost({
    routeId: fixture.grant.channel.routeId,
    onMessage: (envelope) => delivered.push(envelope),
  });
  expect(delivered).toHaveLength(2);
  expect(relay.snapshot().queues.total).toEqual({ messages: 0, bytes: 0 });

  const byteBoundedRelay = new InMemoryRelay({
    maxMessageBytes: first.byteLength,
    maxQueuedMessages: 10,
    maxQueuedBytes: first.byteLength * 10,
    maxQueuedMessagesPerRoute: 10,
    maxQueuedBytesPerRoute: first.byteLength - 1,
  });
  const byteBoundedDevice = byteBoundedRelay.connectDevice({
    routeId: fixture.grant.channel.routeId,
    onMessage: () => undefined,
  });
  expectRelayError(() => byteBoundedDevice.send(first), "route_queue_bytes_exceeded");
  expect(byteBoundedRelay.snapshot().queues.total).toEqual({ messages: 0, bytes: 0 });

  const globalBoundedRelay = new InMemoryRelay({
    maxMessageBytes: first.byteLength,
    maxQueuedMessages: 1,
    maxQueuedBytes: first.byteLength * 2,
    maxQueuedMessagesPerRoute: 1,
    maxQueuedBytesPerRoute: first.byteLength,
  });
  const firstRoute = globalBoundedRelay.connectDevice({
    routeId: fixture.grant.channel.routeId,
    onMessage: () => undefined,
  });
  const secondRouteId = "route_global_secondary";
  const secondRouteEnvelope = parseOpaqueRelayEnvelope({
    ...first,
    routeId: secondRouteId,
    messageId: "message_global_secondary",
  });
  const secondRoute = globalBoundedRelay.connectDevice({
    routeId: secondRouteId,
    onMessage: () => undefined,
  });
  expect(firstRoute.send(first)).toEqual({ status: "queued" });
  expectRelayError(() => secondRoute.send(secondRouteEnvelope), "queue_messages_exceeded");
  expect(globalBoundedRelay.snapshot().queues.total.messages).toBe(1);

  const globalByteRelay = new InMemoryRelay({
    maxMessageBytes: first.byteLength,
    maxQueuedMessages: 2,
    maxQueuedBytes: first.byteLength * 2 - 1,
    maxQueuedMessagesPerRoute: 1,
    maxQueuedBytesPerRoute: first.byteLength,
  });
  const globalByteFirstRoute = globalByteRelay.connectDevice({
    routeId: fixture.grant.channel.routeId,
    onMessage: () => undefined,
  });
  const globalByteSecondRoute = globalByteRelay.connectDevice({
    routeId: secondRouteId,
    onMessage: () => undefined,
  });
  expect(globalByteFirstRoute.send(first)).toEqual({ status: "queued" });
  expectRelayError(
    () => globalByteSecondRoute.send(secondRouteEnvelope),
    "queue_bytes_exceeded",
  );
  expect(globalByteRelay.snapshot().queues.total).toEqual({
    messages: 1,
    bytes: first.byteLength,
  });

  const connectionBoundedRelay = new InMemoryRelay({ maxConnectionsPerEndpoint: 1 });
  const initialRoute = connectionBoundedRelay.connectDevice({
    routeId: "route_connection_a",
    onMessage: () => undefined,
  });
  const replacementRoute = connectionBoundedRelay.connectDevice({
    routeId: "route_connection_a",
    onMessage: () => undefined,
  });
  expect(initialRoute.connected).toBe(false);
  expect(replacementRoute.connected).toBe(true);
  expectConnectionError(() => connectionBoundedRelay.connectDevice({
    routeId: "route_connection_b",
    onMessage: () => undefined,
  }), "connection_limit_exceeded");
  replacementRoute.disconnect();
  expect(connectionBoundedRelay.connectDevice({
    routeId: "route_connection_b",
    onMessage: () => undefined,
  }).connected).toBe(true);
});

test("fake mobile reaches the host-neutral service with ACK, offline reconnect, and queued revocation", async () => {
  const fixture = pairReadOnlyDevice({ clock: () => 3_000 });
  const relay = new InMemoryRelay();
  const service = new MockControlService();
  const bridge = new HostBridge({
    hostId: HOST_ID,
    routeId: fixture.grant.channel.routeId,
    controlService: service,
    credentials: fixture.authority,
    codec: fixture.authority,
    now: () => 3_000,
  });
  bridge.connect(relay);
  const mobile = new FakeMobileClient({
    relay,
    identity: fixture.device,
    pairing: fixture.grant,
    hostId: HOST_ID,
    sessionId: "control_session_vertical",
    clock: () => 3_000,
    requestIdFactory: sequentialIdentifier("request_vertical"),
    messageIdFactory: sequentialIdentifier("message_vertical"),
  });
  mobile.connect();

  const online = mobile.sendRequest("sessions.list", { status: "active" });
  expect(online.status).toBe("delivered");
  await waitForFrames(mobile, online.sequence, ["ack", "result"]);
  expect(service.calls).toEqual([{ ordinal: 1, operation: "sessions.list" }]);
  expect(mobile.acknowledgedSequence).toBe(1);

  bridge.disconnect();
  const offline = mobile.sendRequest("sessions.list", { status: "active" });
  expect(offline.status).toBe("queued");
  expect(relay.snapshot().queues.toHosts.messages).toBe(1);
  bridge.reconnect(relay);
  await waitForFrames(mobile, offline.sequence, ["ack", "result"]);
  expect(service.calls).toHaveLength(2);
  expect(relay.snapshot().queues.total).toEqual({ messages: 0, bytes: 0 });

  bridge.disconnect();
  const revokedWhileQueued = mobile.sendRequest("sessions.list", { status: "active" });
  expect(revokedWhileQueued.status).toBe("queued");
  expect(fixture.authority.revokeCredential(fixture.grant.credential)).toBe(true);
  bridge.reconnect(relay);
  await waitForFrames(mobile, revokedWhileQueued.sequence, ["error"]);
  const revokedFrames = framesAt(mobile.receivedFrames(), revokedWhileQueued.sequence);
  expect(revokedFrames.some((frame) => frame.type === "ack")).toBe(false);
  expect(revokedFrames).toMatchObject([
    { type: "error", error: { code: "credential_revoked" } },
  ]);
  expect(service.calls).toHaveLength(2);
  expect(mobile.unackedSequences).toEqual([]);

  for (const diagnostics of [
    JSON.stringify(relay.snapshot()),
    JSON.stringify(bridge.snapshot()),
    JSON.stringify(mobile.snapshot()),
  ]) {
    for (const secret of [
      fixture.device.deviceId,
      fixture.grant.credential,
      fixture.challenge.nonce,
      fixture.grant.channel.key,
      fixture.grant.channel.routeId,
      "control_session_vertical",
    ]) {
      expect(diagnostics).not.toContain(secret);
    }
  }
});

test("bridge rejects forgery, session reset, replay, gaps, and scope escalation before service invocation", async () => {
  const fixture = pairReadOnlyDevice({ clock: () => 4_000 });
  const relay = new InMemoryRelay();
  const service = new RecordingControlService();
  const bridge = new HostBridge({
    hostId: HOST_ID,
    routeId: fixture.grant.channel.routeId,
    controlService: service,
    credentials: fixture.authority,
    codec: fixture.authority,
    now: () => 4_000,
  });
  bridge.connect(relay);

  const outbound: RemoteControlFrame[] = [];
  relay.connectDevice({
    routeId: fixture.grant.channel.routeId,
    onMessage: (envelope) => {
      const decoded = openRelayEnvelope<unknown>(fixture.grant.channel, envelope, {
        expectedDirection: "host_to_device",
      });
      outbound.push(parseRemoteControlFrame(decoded));
    },
  });

  const validSequenceOne = readRequest(fixture, {
    sequence: 1,
    sessionId: "control_session_attacks",
    requestId: "request_attack_valid_1",
  });
  const validEnvelope = sealRequest(
    fixture.grant,
    validSequenceOne,
    "message_attack_valid_1",
  );

  const tampered = {
    ...validEnvelope,
    ciphertext: Uint8Array.from(validEnvelope.ciphertext),
  };
  tampered.ciphertext[12] = (tampered.ciphertext[12] ?? 0) ^ 1;
  expect(await bridge.receive(tampered)).toMatchObject({
    status: "rejected",
    code: "authentication_failed",
    admitted: false,
  });
  expect(service.calls).toEqual([]);
  expect(takeFrames(outbound)).toEqual([]);

  const forgedCredential = readRequest(fixture, {
    sequence: 1,
    sessionId: "control_session_attacks",
    requestId: "request_attack_forged_credential",
    credential: mutateBearer(fixture.grant.credential),
  });
  expect(await bridge.receive(sealRequest(
    fixture.grant,
    forgedCredential,
    "message_attack_forged_credential",
  ))).toMatchObject({ status: "rejected", code: "authentication_failed", admitted: false });
  expectNoAck(takeFrames(outbound));
  expect(service.calls).toEqual([]);

  const forgedDevice = readRequest(fixture, {
    sequence: 1,
    sessionId: "control_session_attacks",
    requestId: "request_attack_forged_device",
    deviceId: generateDeviceIdentity().deviceId,
  });
  expect(await bridge.receive(sealRequest(
    fixture.grant,
    forgedDevice,
    "message_attack_forged_device",
  ))).toMatchObject({ status: "rejected", code: "authentication_failed", admitted: false });
  expectNoAck(takeFrames(outbound));
  expect(service.calls).toEqual([]);

  const wrongHost = readRequest(fixture, {
    sequence: 1,
    sessionId: "control_session_attacks",
    requestId: "request_attack_wrong_host",
    hostId: "host_attacker",
  });
  expect(await bridge.receive(sealRequest(
    fixture.grant,
    wrongHost,
    "message_attack_wrong_host",
  ))).toMatchObject({ status: "rejected", code: "authentication_failed", admitted: false });
  expectNoAck(takeFrames(outbound));
  expect(service.calls).toEqual([]);

  const escalation = stopRequest(fixture, {
    sequence: 1,
    sessionId: "control_session_attacks",
    requestId: "request_attack_scope",
  });
  expect(await bridge.receive(sealRequest(
    fixture.grant,
    escalation,
    "message_attack_scope",
  ))).toMatchObject({ status: "rejected", code: "forbidden", admitted: false });
  expectNoAck(takeFrames(outbound));
  expect(service.calls).toEqual([]);

  expect(openRelayEnvelope<unknown>(fixture.grant.channel, validEnvelope, {
    expectedDirection: "device_to_host",
  })).toMatchObject({ requestId: "request_attack_valid_1" });
  expect(await bridge.receive(validEnvelope)).toMatchObject({
    status: "accepted",
    sequence: 1,
    acknowledgementSent: true,
    completion: "succeeded",
  });
  expect(takeFrames(outbound).map((frame) => frame.type)).toEqual(["ack", "result"]);
  expect(service.calls).toEqual(["sessions.list"]);

  expect(await bridge.receive(validEnvelope)).toMatchObject({
    status: "resync",
    acknowledgedSequence: 1,
    expectedSequence: 2,
  });
  expect(takeFrames(outbound)).toMatchObject([
    { type: "resync", reason: "ack_timeout", acknowledgedSequence: 1, expectedSequence: 2 },
  ]);
  expect(service.calls).toEqual(["sessions.list"]);

  const reencryptionReplay = sealRequest(
    fixture.grant,
    validSequenceOne,
    "message_attack_reencrypted_replay",
  );
  expect(await bridge.receive(reencryptionReplay)).toMatchObject({
    status: "resync",
    acknowledgedSequence: 1,
    expectedSequence: 2,
  });
  expectNoAck(takeFrames(outbound));
  expect(service.calls).toEqual(["sessions.list"]);

  const changedReplay = readRequest(fixture, {
    sequence: 1,
    sessionId: "control_session_attacks",
    requestId: "request_attack_changed_replay",
    query: "different replay payload",
  });
  expect(await bridge.receive(sealRequest(
    fixture.grant,
    changedReplay,
    "message_attack_changed_replay",
  ))).toMatchObject({
    status: "resync",
    acknowledgedSequence: 1,
    expectedSequence: 2,
  });
  expectNoAck(takeFrames(outbound));
  expect(service.calls).toEqual(["sessions.list"]);

  const resetSession = readRequest(fixture, {
    sequence: 1,
    sessionId: "control_session_reset_attempt",
    requestId: "request_attack_session_reset",
  });
  expect(await bridge.receive(sealRequest(
    fixture.grant,
    resetSession,
    "message_attack_session_reset",
  ))).toMatchObject({ status: "rejected", code: "authentication_failed", admitted: false });
  expectNoAck(takeFrames(outbound));
  expect(service.calls).toEqual(["sessions.list"]);

  const gap = readRequest(fixture, {
    sequence: 3,
    sessionId: "control_session_attacks",
    requestId: "request_attack_gap",
  });
  expect(await bridge.receive(sealRequest(
    fixture.grant,
    gap,
    "message_attack_gap",
  ))).toMatchObject({
    status: "resync",
    acknowledgedSequence: 1,
    expectedSequence: 2,
  });
  expect(takeFrames(outbound)).toMatchObject([
    { type: "resync", reason: "sequence_gap", acknowledgedSequence: 1, expectedSequence: 2 },
  ]);
  expect(service.calls).toEqual(["sessions.list"]);

  const validSequenceTwo = readRequest(fixture, {
    sequence: 2,
    sessionId: "control_session_attacks",
    requestId: "request_attack_valid_2",
  });
  const competingSequenceTwo = readRequest(fixture, {
    sequence: 2,
    sessionId: "control_session_attacks",
    requestId: "request_attack_competing_2",
    query: "concurrent alternate payload",
  });
  const concurrentResults = await Promise.all([
    bridge.receive(sealRequest(
      fixture.grant,
      validSequenceTwo,
      "message_attack_valid_2",
    )),
    bridge.receive(sealRequest(
      fixture.grant,
      competingSequenceTwo,
      "message_attack_competing_2",
    )),
  ]);
  expect(concurrentResults.filter((result) => result.status === "accepted")).toHaveLength(1);
  expect(concurrentResults.filter((result) => result.status === "resync")).toHaveLength(1);
  expect(concurrentResults.find((result) => result.status === "resync")).toMatchObject({
    acknowledgedSequence: 2,
    expectedSequence: 3,
  });
  expect(takeFrames(outbound).map((frame) => frame.type)).toEqual([
    "ack",
    "result",
    "resync",
  ]);
  expect(service.calls).toEqual(["sessions.list", "sessions.list"]);

  bridge.reconnect(relay);
  expect(await bridge.receive(sealRequest(
    fixture.grant,
    validSequenceTwo,
    "message_attack_replay_after_reconnect",
  ))).toMatchObject({ status: "resync", acknowledgedSequence: 2, expectedSequence: 3 });
  expect(service.calls).toEqual(["sessions.list", "sessions.list"]);
});

test("ACK commits before a failing side effect and queued completion does not execute twice", async () => {
  const fixture = pairReadOnlyDevice({ clock: () => 5_000 });
  const relay = new InMemoryRelay();
  let invocations = 0;
  const service: RemoteControlService = {
    invoke: () => {
      invocations += 1;
      throw new Error("side effect happened before provider failure");
    },
  };
  const bridge = new HostBridge({
    hostId: HOST_ID,
    routeId: fixture.grant.channel.routeId,
    controlService: service,
    credentials: fixture.authority,
    codec: fixture.authority,
    now: () => 5_000,
  });
  bridge.connect(relay);

  let disconnectAfterAck = true;
  let mobile: FakeMobileClient | undefined;
  mobile = new FakeMobileClient({
    relay,
    identity: fixture.device,
    pairing: fixture.grant,
    hostId: HOST_ID,
    sessionId: "control_session_side_effect",
    clock: () => 5_000,
    requestIdFactory: () => "request_side_effect_1",
    messageIdFactory: sequentialIdentifier("message_side_effect"),
    onFrame: (frame) => {
      if (disconnectAfterAck && frame.type === "ack") {
        disconnectAfterAck = false;
        mobile?.disconnect();
      }
    },
  });
  mobile.connect();
  const receipt = mobile.sendRequest("sessions.list", { status: "active" });

  await waitFor(() => invocations === 1 && relay.snapshot().queues.toDevices.messages === 1);
  expect(framesAt(mobile.receivedFrames(), receipt.sequence).map((frame) => frame.type))
    .toEqual(["ack"]);
  expect(mobile.acknowledgedSequence).toBe(1);
  expect(invocations).toBe(1);

  mobile.connect();
  await waitForFrames(mobile, receipt.sequence, ["ack", "error"]);
  expect(framesAt(mobile.receivedFrames(), receipt.sequence)).toMatchObject([
    { type: "ack", acknowledgedSequence: 1 },
    { type: "error", error: { code: "request_failed" } },
  ]);
  expect(relay.snapshot().queues.total.messages).toBe(0);
  expect(invocations).toBe(1);

  bridge.reconnect(relay);
  const replay = readRequest(fixture, {
    sequence: 1,
    sessionId: "control_session_side_effect",
    requestId: receipt.requestId,
  });
  expect(await bridge.receive(sealRequest(
    fixture.grant,
    replay,
    "message_side_effect_replay",
  ))).toMatchObject({ status: "resync", acknowledgedSequence: 1, expectedSequence: 2 });
  expect(invocations).toBe(1);
});

test("an admitted request with a lost result resyncs as outcome unknown without re-execution", async () => {
  const fixture = pairReadOnlyDevice({ clock: () => 5_500 });
  const relay = new InMemoryRelay({
    maxQueuedMessages: 1,
    maxQueuedBytes: 1_000_000,
    maxQueuedMessagesPerRoute: 1,
    maxQueuedBytesPerRoute: 1_000_000,
  });

  const blockerRoute = "route_result_queue_blocker";
  const blockerHost = relay.connectHost({
    routeId: blockerRoute,
    onMessage: () => undefined,
  });
  expect(blockerHost.send(parseOpaqueRelayEnvelope({
    version: REMOTE_CONTROL_PROTOCOL_VERSION,
    routeId: blockerRoute,
    direction: "host_to_device",
    messageId: "message_result_queue_blocker",
    ciphertext: new Uint8Array([1]),
    byteLength: 1,
    createdAt: 5_500,
  }))).toEqual({ status: "queued" });

  const service = new RecordingControlService();
  const bridge = new HostBridge({
    hostId: HOST_ID,
    routeId: fixture.grant.channel.routeId,
    controlService: service,
    credentials: fixture.authority,
    codec: fixture.authority,
    now: () => 5_500,
  });
  bridge.connect(relay);

  let disconnectAfterAck = true;
  let mobile: FakeMobileClient | undefined;
  mobile = new FakeMobileClient({
    relay,
    identity: fixture.device,
    pairing: fixture.grant,
    hostId: HOST_ID,
    sessionId: "control_session_lost_result",
    clock: () => 5_500,
    requestIdFactory: () => "request_lost_result_1",
    messageIdFactory: sequentialIdentifier("message_lost_result"),
    onFrame: (frame) => {
      if (disconnectAfterAck && frame.type === "ack") {
        disconnectAfterAck = false;
        mobile?.disconnect();
      }
    },
  });
  mobile.connect();
  const receipt = mobile.sendRequest("sessions.list", { status: "active" });
  await waitFor(() => service.calls.length === 1 && bridge.snapshot().pendingMessages === 0);

  expect(framesAt(mobile.receivedFrames(), receipt.sequence).map((frame) => frame.type))
    .toEqual(["ack"]);
  expect(relay.snapshot().queues.toDevices.messages).toBe(1);
  expect(service.calls).toEqual(["sessions.list"]);

  mobile.connect();
  await waitFor(() => mobile?.outcomeUnknown().length === 1);
  expect(mobile.outcomeUnknown()).toMatchObject([{
    type: "local_error",
    code: "outcome_unknown",
    reason: "resync_required",
    sequence: receipt.sequence,
    requestId: receipt.requestId,
  }]);
  expect(mobile.snapshot()).toMatchObject({
    acknowledgedSequence: 1,
    trackedRequests: 0,
    unackedSequences: [],
    outcomeUnknownSequences: [1],
  });
  expect(service.calls).toEqual(["sessions.list"]);
});

test("relay message and offline queue limits reject valid control requests before the service", async () => {
  const fixture = pairReadOnlyDevice({ clock: () => 6_000 });
  const first = sealRequest(fixture.grant, readRequest(fixture, {
    sequence: 1,
    sessionId: "control_session_limits",
    requestId: "request_limit_1",
  }), "message_limit_1");
  const second = sealRequest(fixture.grant, readRequest(fixture, {
    sequence: 2,
    sessionId: "control_session_limits",
    requestId: "request_limit_2",
  }), "message_limit_2");
  const large = sealRequest(fixture.grant, readRequest(fixture, {
    sequence: 2,
    sessionId: "control_session_limits",
    requestId: "request_limit_large",
    query: "界".repeat(100),
  }), "message_limit_large");
  expect(large.byteLength).toBeGreaterThan(first.byteLength);

  const relay = new InMemoryRelay({
    maxMessageBytes: first.byteLength,
    maxQueuedMessages: 1,
    maxQueuedBytes: first.byteLength,
    maxQueuedMessagesPerRoute: 1,
    maxQueuedBytesPerRoute: first.byteLength,
  });
  const service = new RecordingControlService();
  const device = relay.connectDevice({
    routeId: fixture.grant.channel.routeId,
    onMessage: () => undefined,
  });
  expect(device.send(first)).toEqual({ status: "queued" });
  expectRelayError(() => device.send(large), "message_too_large");
  expectRelayError(() => device.send(second), "route_queue_messages_exceeded");
  expect(service.calls).toEqual([]);
  expect(relay.snapshot().queues.total.messages).toBe(1);

  const bridge = new HostBridge({
    hostId: HOST_ID,
    routeId: fixture.grant.channel.routeId,
    controlService: service,
    credentials: fixture.authority,
    codec: fixture.authority,
    now: () => 6_000,
  });
  bridge.connect(relay);
  await waitFor(() => service.calls.length === 1);
  expect(service.calls).toEqual(["sessions.list"]);
  expect(relay.snapshot().queues.toHosts.messages).toBe(0);
});

class RecordingControlService implements RemoteControlService {
  readonly calls: string[] = [];

  invoke(request: Parameters<RemoteControlService["invoke"]>[0]): { ok: boolean } {
    this.calls.push(request.operation);
    return { ok: true };
  }
}

function readRequest(
  fixture: ReturnType<typeof pairReadOnlyDevice>,
  input: {
    sequence: number;
    sessionId: string;
    requestId: string;
    hostId?: string;
    deviceId?: string;
    credential?: string;
    query?: string;
  },
): RemoteControlRequestFrame {
  const parsed = parseRemoteControlFrame({
    version: REMOTE_CONTROL_PROTOCOL_VERSION,
    type: "request",
    hostId: input.hostId ?? HOST_ID,
    sessionId: input.sessionId,
    deviceId: input.deviceId ?? fixture.device.deviceId,
    credential: input.credential ?? fixture.grant.credential,
    sequence: input.sequence,
    requestId: input.requestId,
    capability: "sessions.read",
    operation: "sessions.list",
    payload: {
      status: "active",
      ...(input.query === undefined ? {} : { query: input.query }),
    },
  });
  if (parsed.type !== "request") throw new Error("request parser returned a response");
  return parsed;
}

function stopRequest(
  fixture: ReturnType<typeof pairReadOnlyDevice>,
  input: {
    sequence: number;
    sessionId: string;
    requestId: string;
  },
): RemoteControlRequestFrame {
  const parsed = parseRemoteControlFrame({
    version: REMOTE_CONTROL_PROTOCOL_VERSION,
    type: "request",
    hostId: HOST_ID,
    sessionId: input.sessionId,
    deviceId: fixture.device.deviceId,
    credential: fixture.grant.credential,
    sequence: input.sequence,
    requestId: input.requestId,
    capability: "sessions.stop",
    operation: "session.stop",
    payload: { sessionId: "session_target" },
  });
  if (parsed.type !== "request") throw new Error("request parser returned a response");
  return parsed;
}

function sealRequest(
  grant: PairingGrant,
  request: RemoteControlRequestFrame,
  messageId: string,
): OpaqueRelayEnvelope {
  return parseOpaqueRelayEnvelope(sealRelayEnvelope(
    grant.channel,
    "device_to_host",
    request,
    { createdAt: 1, messageId },
  ));
}

function sequentialIdentifier(prefix: string): () => string {
  let next = 1;
  return () => `${prefix}_${next++}`;
}

function framesAt(
  frames: readonly RemoteControlFrame[],
  sequence: number,
): RemoteControlFrame[] {
  return frames.filter((frame) => "sequence" in frame && frame.sequence === sequence);
}

function takeFrames(frames: RemoteControlFrame[]): RemoteControlFrame[] {
  const taken = [...frames];
  frames.length = 0;
  return taken;
}

function expectNoAck(frames: readonly RemoteControlFrame[]): void {
  expect(frames.length).toBeGreaterThan(0);
  expect(frames.some((frame) => frame.type === "ack")).toBe(false);
}

async function waitForFrames(
  mobile: FakeMobileClient,
  sequence: number,
  types: readonly RemoteControlFrame["type"][],
): Promise<void> {
  await waitFor(() => {
    const frames = framesAt(mobile.receivedFrames(), sequence);
    return types.every((type) => frames.some((frame) => frame.type === type));
  });
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("timed out waiting for remote-control state");
}

function pairReadOnlyDevice(input: {
  clock: () => number;
  credentialTtlMs?: number;
}): {
  authority: InMemoryPairingAuthority;
  device: ReturnType<typeof generateDeviceIdentity>;
  challenge: PairingChallenge;
  grant: PairingGrant;
} {
  const authority = new InMemoryPairingAuthority({
    hostId: HOST_ID,
    allowedCapabilities: ["sessions.read"],
    clock: input.clock,
    ...(input.credentialTtlMs === undefined
      ? {}
      : { credentialTtlMs: input.credentialTtlMs }),
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
  return { authority, device, challenge, grant };
}

function mutateBearer(credential: string): string {
  const last = credential.at(-1);
  if (last === undefined) throw new Error("credential is empty");
  return `${credential.slice(0, -1)}${last === "A" ? "B" : "A"}`;
}

function expectPairingError(
  action: () => unknown,
  code: PairingSecurityErrorCode,
): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(PairingSecurityError);
  expect((thrown as PairingSecurityError).code).toBe(code);
}

function expectRelayError(
  action: () => unknown,
  code: RelayLimitErrorCode,
): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RelayLimitError);
  expect((thrown as RelayLimitError).code).toBe(code);
}

function expectConnectionError(
  action: () => unknown,
  code: RelayConnectionErrorCode,
): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RelayConnectionError);
  expect((thrown as RelayConnectionError).code).toBe(code);
}
