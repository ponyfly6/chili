import { FakeMobileClient } from "./fake-mobile-client.js";
import { HostBridge } from "./host-bridge.js";
import { InMemoryRelay } from "./in-memory-relay.js";
import { MockControlService } from "./mock-control-service.js";
import {
  InMemoryPairingAuthority,
  PairingSecurityError,
  createPairingProof,
  generateDeviceIdentity,
} from "./pairing-security.js";
import type { RemoteControlFrame } from "./protocol.js";

const HOST_ID = "host_demo";
const READ_CAPABILITY = "sessions.read" as const;

async function main(): Promise<void> {
  const identity = generateDeviceIdentity();
  const authority = new InMemoryPairingAuthority({
    hostId: HOST_ID,
    allowedCapabilities: [READ_CAPABILITY],
  });
  const challenge = authority.beginPairing({
    deviceId: identity.deviceId,
    publicKey: identity.publicKey,
    grantedCapabilities: [READ_CAPABILITY],
  });
  const proof = createPairingProof(challenge, identity.privateKey);
  const pairing = authority.completePairing(proof);

  let nonceWasOneTime = false;
  try {
    authority.completePairing(proof);
  } catch (error) {
    nonceWasOneTime =
      error instanceof PairingSecurityError && error.code === "PAIRING_NONCE_REUSED";
  }
  assert(nonceWasOneTime, "pairing proof must consume its nonce exactly once");
  assert(
    pairing.capabilities.length === 1 &&
      pairing.capabilities[0] === READ_CAPABILITY,
    "pairing must issue a read-only credential",
  );

  const storedCredentials = JSON.stringify(authority.credentialStore.snapshot());
  assert(
    !storedCredentials.includes(pairing.credential),
    "credential store must retain a hash, not the bearer credential",
  );
  assert(
    !storedCredentials.includes(challenge.nonce),
    "credential store must not retain the pairing nonce",
  );

  const relay = new InMemoryRelay();
  const controlService = new MockControlService();
  const bridge = new HostBridge({
    hostId: HOST_ID,
    routeId: pairing.channel.routeId,
    controlService,
    credentials: authority,
    codec: authority,
  });
  bridge.connect(relay);

  const mobile = new FakeMobileClient({
    relay,
    identity,
    pairing,
    hostId: HOST_ID,
  });
  mobile.connect();

  const online = mobile.sendRequest("sessions.list", { status: "active" });
  assert(online.status === "delivered", "online request must reach the host");
  await bridge.whenIdle();
  assertAckAndResult(mobile, online.sequence);

  bridge.disconnect();
  const offline = mobile.sendRequest("sessions.list", { status: "active" });
  assert(offline.status === "queued", "request must queue while the host is offline");
  const queuedBeforeReconnect = relay.snapshot().queues.toHosts.messages;
  assert(queuedBeforeReconnect === 1, "relay must retain one opaque host-bound message");

  bridge.reconnect(relay);
  await bridge.whenIdle();
  assertAckAndResult(mobile, offline.sequence);
  const relayAfterReconnect = relay.snapshot();
  assert(
    relayAfterReconnect.queues.total.messages === 0,
    "host reconnect must drain the relay queue",
  );
  assert(
    mobile.snapshot().unackedSequences.length === 0,
    "both requests must be acknowledged after reconnect",
  );
  assert(
    controlService.calls.length === 2 &&
      controlService.calls.every((call) => call.operation === "sessions.list"),
    "the read-only requests must invoke the host-neutral service exactly once each",
  );

  const relayDiagnostics = JSON.stringify(relayAfterReconnect);
  for (const sensitive of [
    identity.deviceId,
    identity.privateKey,
    challenge.nonce,
    pairing.credential,
    pairing.channel.key,
    pairing.channel.routeId,
  ]) {
    assert(
      !relayDiagnostics.includes(sensitive),
      "relay diagnostics must not expose identity, pairing, or credential material",
    );
  }

  const summary = {
    deviceIdentity: {
      algorithm: identity.algorithm,
      created: true,
    },
    pairing: {
      nonceConsumedOnce: nonceWasOneTime,
      credentialStoredAsHash: true,
      capabilities: [...pairing.capabilities],
    },
    verticalSlice: {
      path: ["fake-mobile", "in-memory-relay", "host-bridge", "mock-service"],
      onlineAckAndResult: true,
      offlineRequestStatus: offline.status,
      queuedBeforeReconnect,
      queuedAfterReconnect: relayAfterReconnect.queues.total.messages,
      finalAcknowledgedSequence: mobile.snapshot().acknowledgedSequence,
      serviceCalls: controlService.calls.map((call) => call.operation),
    },
    secretsIncluded: false,
  };
  const output = JSON.stringify(summary, null, 2);
  for (const sensitive of [
    identity.deviceId,
    identity.publicKey,
    identity.privateKey,
    challenge.nonce,
    pairing.credential,
    pairing.channel.key,
    pairing.channel.routeId,
  ]) {
    assert(!output.includes(sensitive), "demo summary must not include sensitive material");
  }
  console.log(output);
}

function assertAckAndResult(
  mobile: FakeMobileClient,
  sequence: number,
): void {
  const frames = mobile.receivedFrames();
  assert(hasFrame(frames, "ack", sequence), "request must receive an ACK");
  assert(hasFrame(frames, "result", sequence), "request must receive a result");
}

function hasFrame(
  frames: readonly RemoteControlFrame[],
  type: "ack" | "result",
  sequence: number,
): boolean {
  return frames.some((frame) => frame.type === type && frame.sequence === sequence);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

await main();
