import {
  REMOTE_CONTROL_LIMITS,
  parseOpaqueRelayEnvelope,
  parseRemoteControlRouteId,
  type OpaqueRelayEnvelope,
} from "./protocol.js";

export type RelayLimitErrorCode =
  | "message_too_large"
  | "route_queue_messages_exceeded"
  | "route_queue_bytes_exceeded"
  | "queue_messages_exceeded"
  | "queue_bytes_exceeded";

export class RelayLimitError extends Error {
  readonly code: RelayLimitErrorCode;
  readonly actual: number;
  readonly limit: number;

  constructor(code: RelayLimitErrorCode, actual: number, limit: number) {
    super(`${code}: ${actual} exceeds ${limit}`);
    this.name = "RelayLimitError";
    this.code = code;
    this.actual = actual;
    this.limit = limit;
  }
}

export type RelayConnectionErrorCode =
  | "connection_closed"
  | "connection_limit_exceeded"
  | "route_mismatch"
  | "direction_mismatch";

export class RelayConnectionError extends Error {
  readonly code: RelayConnectionErrorCode;

  constructor(code: RelayConnectionErrorCode) {
    super(code);
    this.name = "RelayConnectionError";
    this.code = code;
  }
}

export interface InMemoryRelayOptions {
  /** Maximum ciphertext bytes in one relay envelope. */
  maxMessageBytes?: number;
  /** Maximum queued messages across all disconnected routes. */
  maxQueuedMessages?: number;
  /** Maximum queued ciphertext bytes across all disconnected routes. */
  maxQueuedBytes?: number;
  /** Maximum queued messages for any one disconnected route. */
  maxQueuedMessagesPerRoute?: number;
  /** Maximum queued ciphertext bytes for any one disconnected route. */
  maxQueuedBytesPerRoute?: number;
  /** Maximum distinct connected routes in each endpoint map. */
  maxConnectionsPerEndpoint?: number;
}

export interface RelayLimits {
  maxMessageBytes: number;
  maxQueuedMessages: number;
  maxQueuedBytes: number;
  maxQueuedMessagesPerRoute: number;
  maxQueuedBytesPerRoute: number;
  maxConnectionsPerEndpoint: number;
}

export interface RelaySendResult {
  status: "delivered" | "queued";
}

export type RelayMessageHandler = (envelope: OpaqueRelayEnvelope) => void;

export interface RelayConnectOptions {
  routeId: string;
  onMessage: RelayMessageHandler;
}

export interface RelayConnection {
  readonly connected: boolean;
  readonly routeId: string;
  send(envelope: OpaqueRelayEnvelope): RelaySendResult;
  disconnect(): void;
}

export interface InMemoryRelaySnapshot {
  limits: RelayLimits;
  connections: {
    hosts: number;
    devices: number;
  };
  queues: {
    toHosts: {
      messages: number;
      bytes: number;
    };
    toDevices: {
      messages: number;
      bytes: number;
    };
    total: {
      messages: number;
      bytes: number;
    };
  };
}

type Endpoint = "host" | "device";

interface ConnectionRecord {
  token: symbol;
  onMessage: RelayMessageHandler;
}

interface QueuedEnvelope {
  envelope: OpaqueRelayEnvelope;
  bytes: number;
}

interface QueueCounters {
  messages: number;
  bytes: number;
}

const DEFAULT_MAX_QUEUED_MESSAGES = REMOTE_CONTROL_LIMITS.maxQueueMessages;
const DEFAULT_MAX_QUEUED_BYTES = REMOTE_CONTROL_LIMITS.maxQueueBytes;
const DEFAULT_MAX_QUEUED_MESSAGES_PER_ROUTE = Math.max(
  1,
  Math.floor(REMOTE_CONTROL_LIMITS.maxQueueMessages / 4),
);
const DEFAULT_MAX_QUEUED_BYTES_PER_ROUTE = Math.max(
  REMOTE_CONTROL_LIMITS.maxCiphertextBytes,
  Math.floor(REMOTE_CONTROL_LIMITS.maxQueueBytes / 4),
);
const DEFAULT_MAX_CONNECTIONS_PER_ENDPOINT = 128;

/**
 * A deliberately ignorant relay for Phase 0 tests.
 *
 * It routes only by a random channel alias (`routeId`) and stores opaque
 * ciphertext while an endpoint is offline. Device identity, credentials,
 * protocol sequence numbers, capabilities, operations, and request payloads
 * belong inside the authenticated ciphertext and are never represented here.
 */
export class InMemoryRelay {
  readonly limits: RelayLimits;

  readonly #hosts = new Map<string, ConnectionRecord>();
  readonly #devices = new Map<string, ConnectionRecord>();
  readonly #toHosts = new Map<string, QueuedEnvelope[]>();
  readonly #toDevices = new Map<string, QueuedEnvelope[]>();
  readonly #toHostCounters: QueueCounters = { messages: 0, bytes: 0 };
  readonly #toDeviceCounters: QueueCounters = { messages: 0, bytes: 0 };

  constructor(options: InMemoryRelayOptions = {}) {
    const maxMessageBytes = boundedPositiveInteger(
      options.maxMessageBytes ?? REMOTE_CONTROL_LIMITS.maxCiphertextBytes,
      "maxMessageBytes",
      REMOTE_CONTROL_LIMITS.maxCiphertextBytes,
    );
    const maxQueuedMessages = boundedPositiveInteger(
      options.maxQueuedMessages ?? DEFAULT_MAX_QUEUED_MESSAGES,
      "maxQueuedMessages",
      REMOTE_CONTROL_LIMITS.maxQueueMessages,
    );
    const maxQueuedBytes = boundedPositiveInteger(
      options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES,
      "maxQueuedBytes",
      REMOTE_CONTROL_LIMITS.maxQueueBytes,
    );
    const maxQueuedMessagesPerRoute = positiveInteger(
      options.maxQueuedMessagesPerRoute ??
        Math.min(DEFAULT_MAX_QUEUED_MESSAGES_PER_ROUTE, maxQueuedMessages),
      "maxQueuedMessagesPerRoute",
    );
    const maxQueuedBytesPerRoute = positiveInteger(
      options.maxQueuedBytesPerRoute ??
        Math.min(DEFAULT_MAX_QUEUED_BYTES_PER_ROUTE, maxQueuedBytes),
      "maxQueuedBytesPerRoute",
    );
    const maxConnectionsPerEndpoint = positiveInteger(
      options.maxConnectionsPerEndpoint ?? DEFAULT_MAX_CONNECTIONS_PER_ENDPOINT,
      "maxConnectionsPerEndpoint",
    );
    if (maxQueuedMessagesPerRoute > maxQueuedMessages) {
      throw new TypeError(
        "maxQueuedMessagesPerRoute must not exceed maxQueuedMessages",
      );
    }
    if (maxQueuedBytesPerRoute > maxQueuedBytes) {
      throw new TypeError("maxQueuedBytesPerRoute must not exceed maxQueuedBytes");
    }
    this.limits = Object.freeze({
      maxMessageBytes,
      maxQueuedMessages,
      maxQueuedBytes,
      maxQueuedMessagesPerRoute,
      maxQueuedBytesPerRoute,
      maxConnectionsPerEndpoint,
    });
  }

  connectHost(options: RelayConnectOptions): RelayConnection {
    return this.#connect("host", options);
  }

  connectDevice(options: RelayConnectOptions): RelayConnection {
    return this.#connect("device", options);
  }

  /** Returns aggregate counters only; route aliases and payloads are omitted. */
  snapshot(): InMemoryRelaySnapshot {
    const totalMessages =
      this.#toHostCounters.messages + this.#toDeviceCounters.messages;
    const totalBytes = this.#toHostCounters.bytes + this.#toDeviceCounters.bytes;
    return {
      limits: { ...this.limits },
      connections: {
        hosts: this.#hosts.size,
        devices: this.#devices.size,
      },
      queues: {
        toHosts: { ...this.#toHostCounters },
        toDevices: { ...this.#toDeviceCounters },
        total: { messages: totalMessages, bytes: totalBytes },
      },
    };
  }

  #connect(endpoint: Endpoint, options: RelayConnectOptions): RelayConnection {
    if (typeof options.onMessage !== "function") {
      throw new TypeError("onMessage must be a function");
    }
    const routeId = parseRemoteControlRouteId(options.routeId, "routeId");
    const connections = this.#connectionsFor(endpoint);
    if (
      !connections.has(routeId) &&
      connections.size >= this.limits.maxConnectionsPerEndpoint
    ) {
      throw new RelayConnectionError("connection_limit_exceeded");
    }
    const token = Symbol(endpoint);
    const record: ConnectionRecord = { token, onMessage: options.onMessage };

    // A reconnect atomically supersedes the stale connection for this route.
    connections.set(routeId, record);
    try {
      this.#drain(endpoint, routeId, record);
    } catch (error) {
      // Do not leave behind a live endpoint for which the caller never
      // received a connection handle.
      if (connections.get(routeId)?.token === token) {
        connections.delete(routeId);
      }
      throw error;
    }

    return {
      get connected(): boolean {
        return connections.get(routeId)?.token === token;
      },
      routeId,
      send: (envelope) => {
        if (connections.get(routeId)?.token !== token) {
          throw new RelayConnectionError("connection_closed");
        }
        return this.#send(endpoint, routeId, envelope);
      },
      disconnect: () => {
        if (connections.get(routeId)?.token === token) {
          connections.delete(routeId);
        }
      },
    };
  }

  #send(
    sender: Endpoint,
    routeId: string,
    candidate: OpaqueRelayEnvelope,
  ): RelaySendResult {
    const envelope = parseOpaqueRelayEnvelope(candidate);
    if (envelope.routeId !== routeId) {
      throw new RelayConnectionError("route_mismatch");
    }

    const expectedDirection =
      sender === "device" ? "device_to_host" : "host_to_device";
    if (envelope.direction !== expectedDirection) {
      throw new RelayConnectionError("direction_mismatch");
    }
    if (envelope.byteLength > this.limits.maxMessageBytes) {
      throw new RelayLimitError(
        "message_too_large",
        envelope.byteLength,
        this.limits.maxMessageBytes,
      );
    }

    const recipient: Endpoint = sender === "device" ? "host" : "device";
    const connected = this.#connectionsFor(recipient).get(routeId);
    if (connected !== undefined) {
      connected.onMessage(copyEnvelope(envelope));
      return { status: "delivered" };
    }

    this.#enqueue(recipient, routeId, envelope);
    return { status: "queued" };
  }

  #enqueue(
    recipient: Endpoint,
    routeId: string,
    envelope: OpaqueRelayEnvelope,
  ): void {
    const queues = this.#queuesFor(recipient);
    const routeQueue = queues.get(routeId) ?? [];
    const routeUsage = this.#routeQueueCounters(routeId);
    const nextRouteMessages = routeUsage.messages + 1;
    if (nextRouteMessages > this.limits.maxQueuedMessagesPerRoute) {
      throw new RelayLimitError(
        "route_queue_messages_exceeded",
        nextRouteMessages,
        this.limits.maxQueuedMessagesPerRoute,
      );
    }

    const nextRouteBytes = routeUsage.bytes + envelope.byteLength;
    if (nextRouteBytes > this.limits.maxQueuedBytesPerRoute) {
      throw new RelayLimitError(
        "route_queue_bytes_exceeded",
        nextRouteBytes,
        this.limits.maxQueuedBytesPerRoute,
      );
    }

    const total = this.#totalQueueCounters();
    const nextMessages = total.messages + 1;
    if (nextMessages > this.limits.maxQueuedMessages) {
      throw new RelayLimitError(
        "queue_messages_exceeded",
        nextMessages,
        this.limits.maxQueuedMessages,
      );
    }

    const nextBytes = total.bytes + envelope.byteLength;
    if (nextBytes > this.limits.maxQueuedBytes) {
      throw new RelayLimitError(
        "queue_bytes_exceeded",
        nextBytes,
        this.limits.maxQueuedBytes,
      );
    }

    const counters = this.#countersFor(recipient);
    const queue = routeQueue;
    if (!queues.has(routeId)) {
      queues.set(routeId, queue);
    }
    queue.push({ envelope: copyEnvelope(envelope), bytes: envelope.byteLength });
    counters.messages += 1;
    counters.bytes += envelope.byteLength;
  }

  #drain(
    recipient: Endpoint,
    routeId: string,
    connection: ConnectionRecord,
  ): void {
    const queues = this.#queuesFor(recipient);
    const queue = queues.get(routeId);
    if (queue === undefined) {
      return;
    }

    const connections = this.#connectionsFor(recipient);
    const counters = this.#countersFor(recipient);
    while (
      queue.length > 0 &&
      connections.get(routeId)?.token === connection.token
    ) {
      const queued = queue.shift();
      if (queued === undefined) {
        break;
      }
      counters.messages -= 1;
      counters.bytes -= queued.bytes;
      // The relay considers handoff complete once the endpoint callback owns a
      // copy. Re-queueing application failures would create a poison message
      // that permanently prevents later ciphertext from draining.
      try {
        connection.onMessage(copyEnvelope(queued.envelope));
      } catch (error) {
        if (queue.length === 0) {
          queues.delete(routeId);
        }
        throw error;
      }
    }

    if (queue.length === 0) {
      queues.delete(routeId);
    }
  }

  #connectionsFor(endpoint: Endpoint): Map<string, ConnectionRecord> {
    return endpoint === "host" ? this.#hosts : this.#devices;
  }

  #queuesFor(endpoint: Endpoint): Map<string, QueuedEnvelope[]> {
    return endpoint === "host" ? this.#toHosts : this.#toDevices;
  }

  #countersFor(endpoint: Endpoint): QueueCounters {
    return endpoint === "host" ? this.#toHostCounters : this.#toDeviceCounters;
  }

  #totalQueueCounters(): QueueCounters {
    return {
      messages: this.#toHostCounters.messages + this.#toDeviceCounters.messages,
      bytes: this.#toHostCounters.bytes + this.#toDeviceCounters.bytes,
    };
  }

  #routeQueueCounters(routeId: string): QueueCounters {
    let messages = 0;
    let bytes = 0;
    for (const queue of [this.#toHosts.get(routeId), this.#toDevices.get(routeId)]) {
      if (queue === undefined) {
        continue;
      }
      messages += queue.length;
      for (const queued of queue) {
        bytes += queued.bytes;
      }
    }
    return { messages, bytes };
  }
}

function copyEnvelope(envelope: OpaqueRelayEnvelope): OpaqueRelayEnvelope {
  return {
    ...envelope,
    // Buffer overrides `.slice()` with view semantics. `Uint8Array.from`
    // always owns a fresh backing store, isolating the queue/recipient from a
    // sender that mutates its original ciphertext after admission.
    ciphertext: Uint8Array.from(envelope.ciphertext),
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function boundedPositiveInteger(
  value: number,
  name: string,
  maximum: number,
): number {
  const parsed = positiveInteger(value, name);
  if (parsed > maximum) {
    throw new TypeError(`${name} must not exceed ${maximum}`);
  }
  return parsed;
}
