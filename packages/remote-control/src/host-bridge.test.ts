import { expect, test } from "bun:test";

import {
  HostBridge,
  type HostBridgeCredentialAuthorizer,
  type HostBridgeLimits,
  type RemoteControlService,
} from "./host-bridge.js";
import { InMemoryRelay } from "./in-memory-relay.js";
import {
  InMemoryPairingAuthority,
  createPairingProof,
  generateDeviceIdentity,
  sealRelayEnvelope,
  type PairingGrant,
} from "./pairing-security.js";
import {
  REMOTE_CONTROL_LIMITS,
  REMOTE_CONTROL_PROTOCOL_VERSION,
  parseOpaqueRelayEnvelope,
  parseRemoteControlFrame,
  type OpaqueRelayEnvelope,
  type RemoteControlJsonValue,
  type RemoteControlRequestFrame,
} from "./protocol.js";

const HOST_ID = "host_bridge_edges";
const NOW = 10_000;

test("maxPendingMessages rejects concurrent excess without an extra service invocation", async () => {
  const fixture = pairFixture();
  const firstEnvelope = sealRequest(fixture, request(fixture, {
    sequence: 1,
    sessionId: "control_pending_count",
    requestId: "request_pending_count_1",
  }), "message_pending_count_1");
  const secondEnvelope = sealRequest(fixture, request(fixture, {
    sequence: 2,
    sessionId: "control_pending_count",
    requestId: "request_pending_count_2",
  }), "message_pending_count_2");
  const started = deferred<void>();
  const release = deferred<RemoteControlJsonValue>();
  let invocations = 0;
  const bridge = connectedBridge(fixture, {
    invoke: () => {
      invocations += 1;
      started.resolve(undefined);
      return release.promise;
    },
  }, {
    maxPendingMessages: 1,
    maxPendingBytes: REMOTE_CONTROL_LIMITS.maxQueueBytes,
  });

  const first = bridge.receive(firstEnvelope);
  await started.promise;
  expect(bridge.snapshot()).toMatchObject({ pendingMessages: 1 });

  expect(await bridge.receive(secondEnvelope)).toMatchObject({
    status: "rejected",
    code: "limit_exceeded",
    admitted: false,
  });
  expect(invocations).toBe(1);

  release.resolve({ ok: true });
  expect(await first).toMatchObject({ status: "accepted", sequence: 1 });
  await bridge.whenIdle();
  expect(bridge.snapshot()).toMatchObject({ pendingMessages: 0, pendingBytes: 0 });
  expect(invocations).toBe(1);
});

test("maxPendingBytes rejects concurrent excess without an extra service invocation", async () => {
  const fixture = pairFixture();
  const firstEnvelope = sealRequest(fixture, request(fixture, {
    sequence: 1,
    sessionId: "control_pending_bytes",
    requestId: "request_pending_bytes_1",
  }), "message_pending_bytes_1");
  const secondEnvelope = sealRequest(fixture, request(fixture, {
    sequence: 2,
    sessionId: "control_pending_bytes",
    requestId: "request_pending_bytes_2",
  }), "message_pending_bytes_2");
  const started = deferred<void>();
  const release = deferred<RemoteControlJsonValue>();
  let invocations = 0;
  const bridge = connectedBridge(fixture, {
    invoke: () => {
      invocations += 1;
      started.resolve(undefined);
      return release.promise;
    },
  }, {
    maxPendingMessages: 2,
    maxPendingBytes: firstEnvelope.byteLength,
  });

  const first = bridge.receive(firstEnvelope);
  await started.promise;
  expect(bridge.snapshot()).toMatchObject({
    pendingMessages: 1,
    pendingBytes: firstEnvelope.byteLength,
  });

  expect(await bridge.receive(secondEnvelope)).toMatchObject({
    status: "rejected",
    code: "limit_exceeded",
    admitted: false,
  });
  expect(invocations).toBe(1);

  release.resolve({ ok: true });
  expect(await first).toMatchObject({ status: "accepted", sequence: 1 });
  await bridge.whenIdle();
  expect(bridge.snapshot()).toMatchObject({ pendingMessages: 0, pendingBytes: 0 });
  expect(invocations).toBe(1);
});

test("same-route credentials cannot exceed the session stream cap", async () => {
  const fixture = pairFixture();
  const secondCredential = fixture.authority.credentialStore.issue({
    hostId: HOST_ID,
    deviceId: fixture.device.deviceId,
    routeId: fixture.grant.channel.routeId,
    capabilities: ["sessions.read"],
  });
  let invocations = 0;
  const bridge = connectedBridge(fixture, {
    invoke: () => {
      invocations += 1;
      return { ok: true };
    },
  }, { maxSessionStreams: 1 });

  expect(await bridge.receive(sealRequest(fixture, request(fixture, {
    sequence: 1,
    sessionId: "control_stream_first",
    requestId: "request_stream_first",
  }), "message_stream_first"))).toMatchObject({ status: "accepted", sequence: 1 });
  expect(bridge.snapshot().sessionStreams).toBe(1);

  expect(await bridge.receive(sealRequest(fixture, request(fixture, {
    credential: secondCredential.credential,
    sequence: 1,
    sessionId: "control_stream_second",
    requestId: "request_stream_second",
  }), "message_stream_second"))).toMatchObject({
    status: "rejected",
    code: "limit_exceeded",
    admitted: false,
  });
  expect(bridge.snapshot().sessionStreams).toBe(1);
  expect(invocations).toBe(1);
});

test("authenticated malformed, unknown-field, and oversized inner frames fail before auth and service", async () => {
  const fixture = pairFixture();
  let authentications = 0;
  let invocations = 0;
  const credentials: HostBridgeCredentialAuthorizer = {
    authenticate: (input) => {
      authentications += 1;
      return fixture.authority.authenticate(input);
    },
  };
  const relay = connectedRelay(fixture);
  const bridge = new HostBridge({
    hostId: HOST_ID,
    routeId: fixture.grant.channel.routeId,
    credentials,
    codec: fixture.authority,
    controlService: {
      invoke: () => {
        invocations += 1;
        return { ok: true };
      },
    },
    now: () => NOW,
    limits: { maxEnvelopeReplayEntries: 1 },
  });
  bridge.connect(relay);

  const valid = request(fixture, {
    sequence: 1,
    sessionId: "control_strict_inner",
    requestId: "request_strict_inner",
  });
  const malformed = sealInner(fixture.grant, null, "message_inner_malformed");
  const unknownField = sealInner(fixture.grant, {
    ...valid,
    unexpectedAuthority: true,
  }, "message_inner_unknown");
  const oversized = sealInner(fixture.grant, {
    ...valid,
    payload: {
      status: "active",
      query: "x".repeat(REMOTE_CONTROL_LIMITS.maxFrameBytes),
    },
  }, "message_inner_oversized", REMOTE_CONTROL_LIMITS.maxCiphertextBytes - 28);
  expect(oversized.byteLength).toBeLessThanOrEqual(REMOTE_CONTROL_LIMITS.maxCiphertextBytes);

  for (const envelope of [malformed, unknownField, oversized]) {
    expect(await bridge.receive(envelope)).toMatchObject({
      status: "rejected",
      code: "invalid_frame",
      admitted: false,
    });
    expect(bridge.snapshot().envelopeReplayEntries).toBe(1);
  }
  expect(authentications).toBe(0);
  expect(invocations).toBe(0);
  expect(bridge.snapshot()).toMatchObject({ sessionStreams: 0, envelopeReplayEntries: 1 });
});

test("a synchronous revocation wins over an envelope waiting for authorization", async () => {
  const fixture = pairFixture();
  const started = deferred<void>();
  const release = deferred<RemoteControlJsonValue>();
  let invocations = 0;
  const bridge = connectedBridge(fixture, {
    invoke: () => {
      invocations += 1;
      started.resolve(undefined);
      return release.promise;
    },
  });
  const first = bridge.receive(sealRequest(fixture, request(fixture, {
    sequence: 1,
    sessionId: "control_revoke_linearization",
    requestId: "request_revoke_linearization_1",
  }), "message_revoke_linearization_1"));
  await started.promise;

  const waiting = bridge.receive(sealRequest(fixture, request(fixture, {
    sequence: 2,
    sessionId: "control_revoke_linearization",
    requestId: "request_revoke_linearization_2",
  }), "message_revoke_linearization_2"));
  expect(bridge.snapshot().pendingMessages).toBe(2);
  expect(fixture.authority.revokeCredential(fixture.grant.credential)).toBe(true);
  release.resolve({ ok: true });

  expect(await first).toMatchObject({ status: "accepted", sequence: 1 });
  expect(await waiting).toMatchObject({
    status: "rejected",
    code: "credential_revoked",
    admitted: false,
  });
  expect(invocations).toBe(1);
  expect(bridge.snapshot()).toMatchObject({ pendingMessages: 0, pendingBytes: 0 });
});

test("connect preserves an offline backlog until a compatible bridge can drain it FIFO", async () => {
  const fixture = pairFixture();
  const relay = new InMemoryRelay();
  const device = relay.connectDevice({
    routeId: fixture.grant.channel.routeId,
    onMessage: () => undefined,
  });
  const first = sealRequest(fixture, request(fixture, {
    sequence: 1,
    sessionId: "control_connect_backlog",
    requestId: "request_connect_backlog_1",
  }), "message_connect_backlog_1");
  const second = sealRequest(fixture, request(fixture, {
    sequence: 2,
    sessionId: "control_connect_backlog",
    requestId: "request_connect_backlog_2",
  }), "message_connect_backlog_2");
  expect(device.send(first)).toEqual({ status: "queued" });
  expect(device.send(second)).toEqual({ status: "queued" });

  const sequences: number[] = [];
  const controlService: RemoteControlService = {
    invoke: (_controlRequest, context) => {
      sequences.push(context.sequence);
      return { ok: true };
    },
  };
  const undersizedBridge = new HostBridge({
    hostId: HOST_ID,
    routeId: fixture.grant.channel.routeId,
    credentials: fixture.authority,
    codec: fixture.authority,
    controlService,
    now: () => NOW,
    limits: {
      maxPendingMessages: 1,
      maxPendingBytes: Math.max(first.byteLength, second.byteLength),
    },
  });

  expect(() => undersizedBridge.connect(relay)).toThrow(
    "Host relay route queue count exceeds the bridge pending limit",
  );
  expect(undersizedBridge.connected).toBe(false);
  expect(sequences).toEqual([]);
  expect(relay.snapshot().queues.toHosts).toEqual({
    messages: 2,
    bytes: first.byteLength + second.byteLength,
  });

  const bridge = new HostBridge({
    hostId: HOST_ID,
    routeId: fixture.grant.channel.routeId,
    credentials: fixture.authority,
    codec: fixture.authority,
    controlService,
    now: () => NOW,
    limits: {
      maxMessageBytes: relay.limits.maxMessageBytes,
      maxPendingMessages: relay.limits.maxQueuedMessagesPerRoute,
      maxPendingBytes: relay.limits.maxQueuedBytesPerRoute,
    },
  });
  bridge.connect(relay);
  await bridge.whenIdle();
  expect(sequences).toEqual([1, 2]);
  expect(relay.snapshot().queues.toHosts).toEqual({ messages: 0, bytes: 0 });
  expect(bridge.snapshot()).toMatchObject({
    pendingMessages: 0,
    pendingBytes: 0,
    sessionStreams: 1,
  });
});

interface Fixture {
  authority: InMemoryPairingAuthority;
  device: ReturnType<typeof generateDeviceIdentity>;
  grant: PairingGrant;
}

function pairFixture(): Fixture {
  const authority = new InMemoryPairingAuthority({
    hostId: HOST_ID,
    allowedCapabilities: ["sessions.read"],
    clock: () => NOW,
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
  return { authority, device, grant };
}

function connectedRelay(fixture: Fixture): InMemoryRelay {
  const relay = new InMemoryRelay();
  relay.connectDevice({
    routeId: fixture.grant.channel.routeId,
    onMessage: () => undefined,
  });
  return relay;
}

function connectedBridge(
  fixture: Fixture,
  controlService: RemoteControlService,
  limits: Partial<HostBridgeLimits> = {},
): HostBridge {
  const bridge = new HostBridge({
    hostId: HOST_ID,
    routeId: fixture.grant.channel.routeId,
    credentials: fixture.authority,
    codec: fixture.authority,
    controlService,
    now: () => NOW,
    limits,
  });
  const relay = new InMemoryRelay({
    maxMessageBytes: limits.maxMessageBytes ?? REMOTE_CONTROL_LIMITS.maxCiphertextBytes,
    maxQueuedMessages: limits.maxPendingMessages ?? REMOTE_CONTROL_LIMITS.maxQueueMessages,
    maxQueuedMessagesPerRoute:
      limits.maxPendingMessages ?? REMOTE_CONTROL_LIMITS.maxQueueMessages,
    maxQueuedBytes: limits.maxPendingBytes ?? REMOTE_CONTROL_LIMITS.maxQueueBytes,
    maxQueuedBytesPerRoute: limits.maxPendingBytes ?? REMOTE_CONTROL_LIMITS.maxQueueBytes,
  });
  relay.connectDevice({
    routeId: fixture.grant.channel.routeId,
    onMessage: () => undefined,
  });
  bridge.connect(relay);
  return bridge;
}

function request(
  fixture: Fixture,
  input: {
    sequence: number;
    sessionId: string;
    requestId: string;
    credential?: string;
  },
): RemoteControlRequestFrame {
  const frame = parseRemoteControlFrame({
    version: REMOTE_CONTROL_PROTOCOL_VERSION,
    type: "request",
    hostId: HOST_ID,
    sessionId: input.sessionId,
    deviceId: fixture.device.deviceId,
    credential: input.credential ?? fixture.grant.credential,
    sequence: input.sequence,
    requestId: input.requestId,
    capability: "sessions.read",
    operation: "sessions.list",
    payload: { status: "active" },
  });
  if (frame.type !== "request") throw new Error("request parser returned a response");
  return frame;
}

function sealRequest(
  fixture: Fixture,
  frame: RemoteControlRequestFrame,
  messageId: string,
): OpaqueRelayEnvelope {
  return sealInner(fixture.grant, frame, messageId);
}

function sealInner(
  grant: PairingGrant,
  inner: unknown,
  messageId: string,
  maxPlaintextBytes?: number,
): OpaqueRelayEnvelope {
  return parseOpaqueRelayEnvelope(sealRelayEnvelope(
    grant.channel,
    "device_to_host",
    inner,
    {
      createdAt: NOW,
      messageId,
      ...(maxPlaintextBytes === undefined ? {} : { maxPlaintextBytes }),
    },
  ));
}

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve(value: Value): void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
