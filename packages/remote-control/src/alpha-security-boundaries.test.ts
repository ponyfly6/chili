import { expect, test } from "bun:test";

import { HostBridge, type RemoteControlService } from "./host-bridge.js";
import { InMemoryRelay } from "./in-memory-relay.js";
import {
  InMemoryPairingAuthority,
  createPairingProof,
  generateDeviceIdentity,
  sealRelayEnvelope,
  type PairingGrant,
} from "./pairing-security.js";
import {
  REMOTE_CONTROL_CAPABILITIES,
  REMOTE_CONTROL_OPERATIONS,
  parseOpaqueRelayEnvelope,
  requiredCapabilityForOperation,
  type RemoteControlCapability,
  type RemoteControlOperation,
} from "./protocol.js";

const HOST_ID = "host_alpha_independent_review";
const NOW = 20_000;

// Boundary unit evidence only: real TLS/browser/DesktopControlService/runtime
// acceptance is deliberately kept in the separate end-to-end suite.
for (let mask = 1; mask < 1 << REMOTE_CONTROL_CAPABILITIES.length; mask += 1) {
  const granted = REMOTE_CONTROL_CAPABILITIES.filter((_, index) => mask & (1 << index));
  test(`independent capability grants ${granted.join(",")} authorize exactly their four-operation subset`, async () => {
    for (const operation of REMOTE_CONTROL_OPERATIONS) {
      const fixture = setup(granted);
      const allowed = granted.includes(requiredCapabilityForOperation(operation));
      const received = await fixture.bridge.receive(envelope(fixture.grant, request(fixture.grant, operation)));
      expect(received).toMatchObject(allowed
        ? { status: "accepted", sequence: 1 }
        : { status: "rejected", code: "forbidden", admitted: false });
      expect(fixture.invocations()).toBe(allowed ? 1 : 0);
      expect(fixture.bridge.snapshot().sessionStreams).toBe(allowed ? 1 : 0);
      fixture.bridge.disconnect();
    }
  });
}

test("unknown operations and payload-carried authority never invoke the host service", async () => {
  const fixture = setup(REMOTE_CONTROL_CAPABILITIES);
  const valid = request(fixture.grant, "session.send");
  const hostile = [
    { ...valid, operation: "sessions.create" },
    { ...valid, operation: "workspace.select", payload: { path: "/unexpected-workspace" } },
    { ...valid, operation: "permissions.set", payload: { profile: "full-access" } },
    { ...valid, operation: "approval.resolve", payload: { approvalId: "approval_1", decision: "allow_always" } },
    { ...valid, payload: { ...valid.payload, capabilities: REMOTE_CONTROL_CAPABILITIES } },
    { ...valid, payload: { ...valid.payload, workspace: "/unexpected-workspace" } },
    { ...valid, payload: { ...valid.payload, source: "subagent" } },
    { ...valid, payload: { ...valid.payload, credential: fixture.grant.credential } },
    { ...valid, payload: { ...valid.payload, expiresAt: Number.MAX_SAFE_INTEGER } },
    { ...valid, payload: { ...valid.payload, sequence: 0 } },
    JSON.parse(JSON.stringify(valid).replace('"payload":{', '"payload":{"__proto__":{"approved":true},')) as unknown,
  ];
  for (const candidate of hostile) {
    expect(await fixture.bridge.receive(envelope(fixture.grant, candidate))).toMatchObject({
      status: "rejected", code: "invalid_frame", admitted: false,
    });
  }
  expect(fixture.invocations()).toBe(0);
  expect(fixture.bridge.snapshot().sessionStreams).toBe(0);
  // Rejected inputs have not consumed the legitimate next sequence.
  expect(await fixture.bridge.receive(envelope(fixture.grant, valid))).toMatchObject({ status: "accepted", sequence: 1 });
  expect(fixture.invocations()).toBe(1);
  fixture.bridge.disconnect();
});

test("revoking one device cannot reset or revoke another device's authenticated sequence", async () => {
  const authority = authorityFor(REMOTE_CONTROL_CAPABILITIES);
  const first = setup(REMOTE_CONTROL_CAPABILITIES, authority);
  const second = setup(REMOTE_CONTROL_CAPABILITIES, authority);
  const sendFirst = request(first.grant, "session.send");
  const sendSecond = request(second.grant, "session.send");
  expect(await first.bridge.receive(envelope(first.grant, sendFirst))).toMatchObject({ status: "accepted" });
  expect(await second.bridge.receive(envelope(second.grant, sendSecond))).toMatchObject({ status: "accepted" });

  expect(authority.revokeDevice(first.grant.deviceId)).toBe(1);
  expect(await first.bridge.receive(envelope(first.grant, {
    ...sendFirst, sequence: 2, requestId: "request_after_revoke",
  }))).toMatchObject({ status: "rejected", code: "credential_revoked", admitted: false });
  second.bridge.reconnect();
  expect(await second.bridge.receive(envelope(second.grant, sendSecond))).toMatchObject({
    status: "resync", acknowledgedSequence: 1, expectedSequence: 2,
  });
  expect(await second.bridge.receive(envelope(second.grant, {
    ...sendSecond, sequence: 2, requestId: "request_second_device_2",
  }))).toMatchObject({ status: "accepted", sequence: 2 });
  expect(first.invocations()).toBe(1);
  expect(second.invocations()).toBe(2);
  expect(second.bridge.snapshot().sessionStreams).toBe(1);
  first.bridge.disconnect();
  second.bridge.disconnect();
});

function authorityFor(capabilities: readonly RemoteControlCapability[]): InMemoryPairingAuthority {
  return new InMemoryPairingAuthority({ hostId: HOST_ID, allowedCapabilities: capabilities, clock: () => NOW });
}

function setup(capabilities: readonly RemoteControlCapability[], authority = authorityFor(capabilities)) {
  const identity = generateDeviceIdentity();
  const challenge = authority.beginPairing({
    deviceId: identity.deviceId,
    publicKey: identity.publicKey,
    grantedCapabilities: capabilities,
  });
  const grant = authority.completePairing(createPairingProof(challenge, identity.privateKey));
  let count = 0;
  const service: RemoteControlService = { invoke: () => { count += 1; return { accepted: true }; } };
  const bridge = new HostBridge({
    hostId: HOST_ID, routeId: grant.channel.routeId,
    credentials: authority, codec: authority, controlService: service, now: () => NOW,
  });
  bridge.connect(new InMemoryRelay());
  return { authority, grant, bridge, invocations: () => count };
}

function request(grant: PairingGrant, operation: RemoteControlOperation) {
  return {
    version: 1, type: "request", hostId: HOST_ID, sessionId: "control_alpha_review",
    deviceId: grant.deviceId, credential: grant.credential, sequence: 1, requestId: "request_alpha_review",
    capability: requiredCapabilityForOperation(operation), operation,
    payload: operation === "sessions.list" ? {}
      : operation === "session.send" ? { sessionId: "existing_task", text: "queue exactly once", mode: "queue" }
      : { sessionId: "existing_task" },
  };
}

function envelope(grant: PairingGrant, inner: unknown) {
  return parseOpaqueRelayEnvelope(sealRelayEnvelope(grant.channel, "device_to_host", inner, { createdAt: NOW }));
}
