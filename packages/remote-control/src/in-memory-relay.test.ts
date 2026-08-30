import { expect, test } from "bun:test";
import {
  InMemoryRelay,
  RelayConnectionError,
  RelayLimitError,
  type RelayConnectionErrorCode,
  type RelayLimitErrorCode,
} from "./in-memory-relay.js";
import {
  REMOTE_CONTROL_LIMITS,
  REMOTE_CONTROL_PROTOCOL_VERSION,
  RemoteControlProtocolError,
  parseOpaqueRelayEnvelope,
  type OpaqueRelayEnvelope,
  type RemoteControlRelayDirection,
} from "./protocol.js";

test("global byte admission is atomic across routes and endpoint queues", () => {
  const relay = new InMemoryRelay({
    maxMessageBytes: 3,
    maxQueuedMessages: 4,
    maxQueuedBytes: 5,
    maxQueuedMessagesPerRoute: 4,
    maxQueuedBytesPerRoute: 5,
  });
  const routeToHost = "route_global_to_host";
  const routeToDevice = "route_global_to_device";
  const rejectedRoute = "route_global_rejected";
  const device = relay.connectDevice({
    routeId: routeToHost,
    onMessage: () => undefined,
  });
  const host = relay.connectHost({
    routeId: routeToDevice,
    onMessage: () => undefined,
  });
  const rejectedDevice = relay.connectDevice({
    routeId: rejectedRoute,
    onMessage: () => undefined,
  });

  expect(device.send(envelope(
    routeToHost,
    "device_to_host",
    "message_global_to_host",
    [1, 2],
  ))).toEqual({ status: "queued" });
  expect(host.send(envelope(
    routeToDevice,
    "host_to_device",
    "message_global_to_device",
    [3, 4, 5],
  ))).toEqual({ status: "queued" });

  const atLimit = relay.snapshot().queues;
  expect(atLimit.toHosts).toEqual({ messages: 1, bytes: 2 });
  expect(atLimit.toDevices).toEqual({ messages: 1, bytes: 3 });
  expect(atLimit.total).toEqual({ messages: 2, bytes: 5 });

  const rejection = expectRelayLimit(
    () => rejectedDevice.send(envelope(
      rejectedRoute,
      "device_to_host",
      "message_global_one_over",
      [6],
    )),
    "queue_bytes_exceeded",
  );
  expect(rejection.actual).toBe(6);
  expect(rejection.limit).toBe(5);

  // A failed admission must not install an empty route queue or change any
  // aggregate counter.
  expect(relay.snapshot().queues).toEqual(atLimit);
  const rejectedDeliveries: OpaqueRelayEnvelope[] = [];
  relay.connectHost({
    routeId: rejectedRoute,
    onMessage: (received) => rejectedDeliveries.push(received),
  });
  expect(rejectedDeliveries).toEqual([]);
  expect(relay.snapshot().queues).toEqual(atLimit);

  const hostDeliveries: OpaqueRelayEnvelope[] = [];
  relay.connectHost({
    routeId: routeToHost,
    onMessage: (received) => hostDeliveries.push(received),
  });
  const deviceDeliveries: OpaqueRelayEnvelope[] = [];
  relay.connectDevice({
    routeId: routeToDevice,
    onMessage: (received) => deviceDeliveries.push(received),
  });
  expect(hostDeliveries.map((received) => String(received.messageId))).toEqual([
    "message_global_to_host",
  ]);
  expect(deviceDeliveries.map((received) => String(received.messageId))).toEqual([
    "message_global_to_device",
  ]);
  expect(relay.snapshot().queues.total).toEqual({ messages: 0, bytes: 0 });
});

test("host and device connection caps reject new routes but allow same-route reconnect", () => {
  const relay = new InMemoryRelay({ maxConnectionsPerEndpoint: 1 });
  const routeId = "route_connection_shared";

  const firstHost = relay.connectHost({
    routeId,
    onMessage: () => undefined,
  });
  const firstDevice = relay.connectDevice({
    routeId,
    onMessage: () => undefined,
  });
  expect(relay.snapshot().connections).toEqual({ hosts: 1, devices: 1 });

  const replacementHost = relay.connectHost({
    routeId,
    onMessage: () => undefined,
  });
  const replacementDevice = relay.connectDevice({
    routeId,
    onMessage: () => undefined,
  });
  expect(firstHost.connected).toBe(false);
  expect(firstDevice.connected).toBe(false);
  expect(replacementHost.connected).toBe(true);
  expect(replacementDevice.connected).toBe(true);
  expect(relay.snapshot().connections).toEqual({ hosts: 1, devices: 1 });

  // Stale handles cannot remove the replacement occupying the same slot.
  firstHost.disconnect();
  firstDevice.disconnect();
  expect(replacementHost.connected).toBe(true);
  expect(replacementDevice.connected).toBe(true);

  expectConnectionError(
    () => relay.connectHost({
      routeId: "route_connection_second_host",
      onMessage: () => undefined,
    }),
    "connection_limit_exceeded",
  );
  expectConnectionError(
    () => relay.connectDevice({
      routeId: "route_connection_second_device",
      onMessage: () => undefined,
    }),
    "connection_limit_exceeded",
  );
  expect(relay.snapshot().connections).toEqual({ hosts: 1, devices: 1 });
});

test("offline envelopes drain in FIFO order on reconnect and clear all counters", () => {
  const relay = new InMemoryRelay({
    maxMessageBytes: 3,
    maxQueuedMessages: 3,
    maxQueuedBytes: 6,
    maxQueuedMessagesPerRoute: 3,
    maxQueuedBytesPerRoute: 6,
  });
  const routeId = "route_fifo_reconnect";
  const firstHost = relay.connectHost({
    routeId,
    onMessage: () => undefined,
  });
  firstHost.disconnect();
  const device = relay.connectDevice({
    routeId,
    onMessage: () => undefined,
  });

  expect(device.send(envelope(
    routeId,
    "device_to_host",
    "message_fifo_1",
    [1],
  ))).toEqual({ status: "queued" });
  expect(device.send(envelope(
    routeId,
    "device_to_host",
    "message_fifo_2",
    [2, 2],
  ))).toEqual({ status: "queued" });
  expect(device.send(envelope(
    routeId,
    "device_to_host",
    "message_fifo_3",
    [3, 3, 3],
  ))).toEqual({ status: "queued" });
  expect(relay.snapshot().queues.toHosts).toEqual({ messages: 3, bytes: 6 });

  const drained: Array<{ messageId: string; ciphertext: number[] }> = [];
  const reconnectedHost = relay.connectHost({
    routeId,
    onMessage: (received) => drained.push({
      messageId: received.messageId,
      ciphertext: Array.from(received.ciphertext),
    }),
  });
  expect(reconnectedHost.connected).toBe(true);
  expect(drained).toEqual([
    { messageId: "message_fifo_1", ciphertext: [1] },
    { messageId: "message_fifo_2", ciphertext: [2, 2] },
    { messageId: "message_fifo_3", ciphertext: [3, 3, 3] },
  ]);
  expect(relay.snapshot().queues).toEqual({
    toHosts: { messages: 0, bytes: 0 },
    toDevices: { messages: 0, bytes: 0 },
    total: { messages: 0, bytes: 0 },
  });
});

test("live and queued delivery defensively copy sender-owned Buffers", () => {
  const relay = new InMemoryRelay({
    maxMessageBytes: 3,
    maxQueuedMessages: 2,
    maxQueuedBytes: 6,
    maxQueuedMessagesPerRoute: 2,
    maxQueuedBytesPerRoute: 6,
  });

  const liveRoute = "route_copy_live";
  let liveReceived: OpaqueRelayEnvelope | undefined;
  relay.connectHost({
    routeId: liveRoute,
    onMessage: (received) => {
      liveReceived = received;
    },
  });
  const liveDevice = relay.connectDevice({
    routeId: liveRoute,
    onMessage: () => undefined,
  });
  const liveSource = Buffer.from([11, 22, 33]);
  const liveCandidate = senderOwnedEnvelope(
    liveRoute,
    "device_to_host",
    "message_copy_live",
    liveSource,
  );
  expect(liveCandidate.ciphertext).toBe(liveSource);
  expect(liveDevice.send(liveCandidate)).toEqual({ status: "delivered" });
  liveSource.fill(99);

  if (liveReceived === undefined) throw new Error("live envelope was not delivered");
  expect(liveReceived).not.toBe(liveCandidate);
  expect(liveReceived.ciphertext).not.toBe(liveSource);
  expect(Buffer.isBuffer(liveReceived.ciphertext)).toBe(false);
  expect(Array.from(liveReceived.ciphertext)).toEqual([11, 22, 33]);

  const queuedRoute = "route_copy_queued";
  const queuedDevice = relay.connectDevice({
    routeId: queuedRoute,
    onMessage: () => undefined,
  });
  const queuedSource = Buffer.from([44, 55, 66]);
  const queuedCandidate = senderOwnedEnvelope(
    queuedRoute,
    "device_to_host",
    "message_copy_queued",
    queuedSource,
  );
  expect(queuedCandidate.ciphertext).toBe(queuedSource);
  expect(queuedDevice.send(queuedCandidate)).toEqual({ status: "queued" });
  queuedSource.fill(88);

  let queuedReceived: OpaqueRelayEnvelope | undefined;
  relay.connectHost({
    routeId: queuedRoute,
    onMessage: (received) => {
      queuedReceived = received;
    },
  });
  if (queuedReceived === undefined) throw new Error("queued envelope was not drained");
  expect(queuedReceived).not.toBe(queuedCandidate);
  expect(queuedReceived.ciphertext).not.toBe(queuedSource);
  expect(Buffer.isBuffer(queuedReceived.ciphertext)).toBe(false);
  expect(Array.from(queuedReceived.ciphertext)).toEqual([44, 55, 66]);
  expect(relay.snapshot().queues.total).toEqual({ messages: 0, bytes: 0 });
});

test("overlong route ids are rejected before connection-map admission", () => {
  const relay = new InMemoryRelay({ maxConnectionsPerEndpoint: 1 });
  const overlongRoute = "r".repeat(REMOTE_CONTROL_LIMITS.maxRouteIdBytes + 1);

  const hostError = expectProtocolError(() => relay.connectHost({
    routeId: overlongRoute,
    onMessage: () => undefined,
  }));
  const deviceError = expectProtocolError(() => relay.connectDevice({
    routeId: overlongRoute,
    onMessage: () => undefined,
  }));
  expect(hostError.path).toBe("routeId");
  expect(deviceError.path).toBe("routeId");
  expect(relay.snapshot().connections).toEqual({ hosts: 0, devices: 0 });

  // Both endpoint maps still have their only slot available. The exact byte
  // boundary remains admissible.
  const boundaryHostRoute = "h".repeat(REMOTE_CONTROL_LIMITS.maxRouteIdBytes);
  const boundaryDeviceRoute = "d".repeat(REMOTE_CONTROL_LIMITS.maxRouteIdBytes);
  expect(relay.connectHost({
    routeId: boundaryHostRoute,
    onMessage: () => undefined,
  }).connected).toBe(true);
  expect(relay.connectDevice({
    routeId: boundaryDeviceRoute,
    onMessage: () => undefined,
  }).connected).toBe(true);
  expect(relay.snapshot().connections).toEqual({ hosts: 1, devices: 1 });
});

function envelope(
  routeId: string,
  direction: RemoteControlRelayDirection,
  messageId: string,
  ciphertext: readonly number[],
): OpaqueRelayEnvelope {
  const bytes = Uint8Array.from(ciphertext);
  return parseOpaqueRelayEnvelope({
    version: REMOTE_CONTROL_PROTOCOL_VERSION,
    routeId,
    direction,
    messageId,
    ciphertext: bytes,
    byteLength: bytes.byteLength,
    createdAt: 1,
  });
}

function senderOwnedEnvelope(
  routeId: string,
  direction: RemoteControlRelayDirection,
  messageId: string,
  ciphertext: Uint8Array,
): OpaqueRelayEnvelope {
  const parsed = envelope(routeId, direction, messageId, Array.from(ciphertext));
  return {
    ...parsed,
    ciphertext,
    byteLength: ciphertext.byteLength,
  };
}

function expectRelayLimit(
  action: () => unknown,
  code: RelayLimitErrorCode,
): RelayLimitError {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RelayLimitError);
  if (!(thrown instanceof RelayLimitError)) {
    throw new Error(`expected RelayLimitError ${code}`);
  }
  expect(thrown.code).toBe(code);
  return thrown;
}

function expectConnectionError(
  action: () => unknown,
  code: RelayConnectionErrorCode,
): RelayConnectionError {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RelayConnectionError);
  if (!(thrown instanceof RelayConnectionError)) {
    throw new Error(`expected RelayConnectionError ${code}`);
  }
  expect(thrown.code).toBe(code);
  return thrown;
}

function expectProtocolError(action: () => unknown): RemoteControlProtocolError {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RemoteControlProtocolError);
  if (!(thrown instanceof RemoteControlProtocolError)) {
    throw new Error("expected RemoteControlProtocolError");
  }
  return thrown;
}
