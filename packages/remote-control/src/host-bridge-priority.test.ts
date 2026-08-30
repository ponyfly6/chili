import { expect, test } from "bun:test";

import { HostBridge, type HostBridgeEnvelopeCodec, type RemoteControlService } from "./host-bridge.js";
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
  parseOpaqueRelayEnvelope,
  requiredCapabilityForOperation,
  type RemoteControlOperation,
} from "./protocol.js";

const HOST_ID = "host_priority_review";
const NOW = 30_000;

test("eight slow reads leave Stop runnable and rejected reads do not consume a sequence", async () => {
  const reads = Array.from({ length: 8 }, () => deferred<{ ok: boolean }>());
  const started = Array.from({ length: 8 }, () => deferred<void>());
  let readCalls = 0;
  let stopCalls = 0;
  let sendCalls = 0;
  const fixture = setup({
    invoke: (input) => {
      if (input.operation === "session.stop") { stopCalls += 1; return { interrupted: true }; }
      if (input.operation === "session.send") { sendCalls += 1; return { queued: true }; }
      const index = readCalls++;
      started[index]?.resolve();
      return reads[index]?.promise ?? { ok: true };
    },
  });
  const pending = [];
  try {
    for (let index = 0; index < 8; index += 1) {
      pending.push(fixture.bridge.receive(envelope(fixture.grant, "session.snapshot", index + 1)));
      await bounded(started[index]!.promise);
    }
    expect(fixture.bridge.snapshot().pendingMessages).toBe(8);
    expect(await bounded(fixture.bridge.receive(envelope(fixture.grant, "sessions.list", 9)))).toMatchObject({
      status: "rejected", code: "limit_exceeded", admitted: false,
    });
    expect(readCalls).toBe(8);
    // Sequence 9 was not committed by the over-limit read. Stop is allowed to
    // use the next admissible sequence while all eight reads remain unresolved.
    expect(await bounded(fixture.bridge.receive(envelope(fixture.grant, "session.stop", 9)))).toMatchObject({
      status: "accepted", sequence: 9, completion: "succeeded",
    });
    expect(stopCalls).toBe(1);
    const queued = envelope(fixture.grant, "session.send", 10);
    expect(await bounded(fixture.bridge.receive(queued))).toMatchObject({ status: "accepted", sequence: 10 });
    expect(await bounded(fixture.bridge.receive(queued))).toMatchObject({
      status: "resync", acknowledgedSequence: 10, expectedSequence: 11,
    });
    expect(sendCalls).toBe(1);
    expect(fixture.bridge.snapshot().pendingMessages).toBe(8);
  } finally {
    for (const gate of reads) gate.resolve({ ok: true });
    await Promise.all(pending);
  }
  // Completed or failed reads release both their global budget and read quota.
  expect(await bounded(fixture.bridge.receive(envelope(fixture.grant, "sessions.list", 11)))).toMatchObject({
    status: "accepted", sequence: 11,
  });
  await fixture.bridge.whenIdle();
  expect(fixture.bridge.snapshot()).toMatchObject({ pendingMessages: 0, pendingBytes: 0 });
  fixture.bridge.disconnect();
});

for (const action of ["revoke", "disconnect-and-reconnect"] as const) {
  test(`an admitted request cannot invoke after ${action} during asynchronous ACK sealing`, async () => {
    const sealingAck = deferred<void>();
    const releaseAck = deferred<void>();
    let calls = 0;
    let blockFirstAck = true;
    const fixture = setup({ invoke: () => { calls += 1; return { queued: true }; } }, (authority) => ({
      openRelayEnvelope: (value, options) => authority.openRelayEnvelope(value, options),
      sealRelayEnvelope: async (routeId, direction, value) => {
        if (blockFirstAck && typeof value === "object" && value !== null && "type" in value && value.type === "ack") {
          blockFirstAck = false;
          sealingAck.resolve();
          await releaseAck.promise;
        }
        return authority.sealRelayEnvelope(routeId, direction, value);
      },
    }));
    const original = envelope(fixture.grant, "session.send", 1);
    const pending = fixture.bridge.receive(original);
    await bounded(sealingAck.promise);
    expect(calls).toBe(0);
    if (action === "revoke") fixture.authority.revokeDevice(fixture.grant.deviceId);
    else fixture.bridge.reconnect();
    releaseAck.resolve();
    expect(await bounded(pending)).toMatchObject({
      status: "accepted", sequence: 1, completion: "request_failed",
    });
    expect(calls).toBe(0);
    if (action === "disconnect-and-reconnect") {
      // Reconnect retains the old admission high-water even though invocation
      // never began. No transport replay may turn the canceled admission into work.
      expect(await fixture.bridge.receive(original)).toMatchObject({
        status: "resync", acknowledgedSequence: 1, expectedSequence: 2,
      });
      expect(await fixture.bridge.receive(envelope(fixture.grant, "session.stop", 2))).toMatchObject({ status: "accepted" });
      expect(calls).toBe(1);
    }
    await fixture.bridge.whenIdle();
    expect(fixture.bridge.snapshot()).toMatchObject({ pendingMessages: 0, pendingBytes: 0 });
    fixture.bridge.disconnect();
  });
}

test("disconnect aborts only that device's queued host work and reconnect uses a fresh signal", async () => {
  const release = deferred<void>();
  const started = deferred<void>();
  let firstSignal: AbortSignal | undefined;
  let otherSignal: AbortSignal | undefined;
  let freshSignal: AbortSignal | undefined;
  let firstEffects = 0;
  let otherEffects = 0;
  const first = setup({
    invoke: async (_request, context) => {
      if (!firstSignal) { firstSignal = context.signal; started.resolve(); }
      else freshSignal = context.signal;
      await release.promise;
      context.signal?.throwIfAborted();
      firstEffects += 1;
      return { queued: true };
    },
  });
  const other = setup({
    invoke: (_request, context) => {
      otherSignal = context.signal;
      context.signal?.throwIfAborted();
      otherEffects += 1;
      return { queued: true };
    },
  });
  const pending = first.bridge.receive(envelope(first.grant, "session.send", 1));
  await bounded(started.promise);
  expect(firstSignal?.aborted).toBe(false);
  first.bridge.disconnect();
  // Cancellation is synchronous: adapter actors can reject without waiting for
  // sockets, outboxes or asynchronous bridge cleanup to finish.
  expect(firstSignal?.aborted).toBe(true);
  expect(await other.bridge.receive(envelope(other.grant, "session.send", 1))).toMatchObject({ status: "accepted" });
  expect(otherSignal?.aborted).toBe(false);
  release.resolve();
  expect(await bounded(pending)).toMatchObject({ status: "accepted", completion: "request_failed" });
  expect(firstEffects).toBe(0);
  expect(otherEffects).toBe(1);
  first.bridge.reconnect();
  expect(await first.bridge.receive(envelope(first.grant, "session.send", 2))).toMatchObject({ status: "accepted" });
  expect(freshSignal?.aborted).toBe(false);
  expect(freshSignal).not.toBe(firstSignal);
  expect(firstEffects).toBe(1);
  first.bridge.disconnect();
  other.bridge.disconnect();
});

function setup(service: RemoteControlService, codecFactory?: (authority: InMemoryPairingAuthority) => HostBridgeEnvelopeCodec) {
  const authority = new InMemoryPairingAuthority({
    hostId: HOST_ID, allowedCapabilities: REMOTE_CONTROL_CAPABILITIES, clock: () => NOW,
  });
  const identity = generateDeviceIdentity();
  const challenge = authority.beginPairing({
    deviceId: identity.deviceId, publicKey: identity.publicKey, grantedCapabilities: REMOTE_CONTROL_CAPABILITIES,
  });
  const grant = authority.completePairing(createPairingProof(challenge, identity.privateKey));
  const relay = new InMemoryRelay();
  relay.connectDevice({ routeId: grant.channel.routeId, onMessage: () => undefined });
  const bridge = new HostBridge({
    hostId: HOST_ID, routeId: grant.channel.routeId, credentials: authority,
    codec: codecFactory?.(authority) ?? authority, controlService: service, now: () => NOW,
  });
  bridge.connect(relay);
  return { bridge, authority, grant };
}

function envelope(grant: PairingGrant, operation: RemoteControlOperation, sequence: number) {
  return parseOpaqueRelayEnvelope(sealRelayEnvelope(grant.channel, "device_to_host", {
    version: 1, type: "request", hostId: HOST_ID, sessionId: "control_priority",
    deviceId: grant.deviceId, credential: grant.credential, sequence, requestId: `request_${operation}_${sequence}`,
    capability: requiredCapabilityForOperation(operation), operation,
    payload: operation === "sessions.list" ? {}
      : operation === "session.send" ? { sessionId: "existing_task", text: "queue once", mode: "queue" }
      : { sessionId: "existing_task" },
  }, { createdAt: NOW }));
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((done) => { resolve = done; });
  return { promise, resolve };
}

async function bounded<Value>(promise: Promise<Value>): Promise<Value> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Bridge work was blocked by another request")), 1_000); }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
