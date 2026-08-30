import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP, type Socket } from "node:net";
import { extname, join, relative, resolve, sep } from "node:path";

import { HostBridge, type HostBridgeRelay, type RemoteControlService } from "./host-bridge.js";
import { decodeWireEnvelope, encodeWireEnvelope, type WireRelayEnvelope } from "./http-wire.js";
import {
  InMemoryPairingAuthority,
  PairingSecurityError,
  type PairingChallenge,
  type PairingGrant,
  type PairingProof,
} from "./pairing-security.js";
import { REMOTE_CONTROL_CAPABILITIES, REMOTE_CONTROL_LIMITS, type OpaqueRelayEnvelope } from "./protocol.js";

const PAIRING_TTL_MS = 120_000;
const CREDENTIAL_TTL_MS = 8 * 60 * 60 * 1_000;
const MAX_PAIRINGS = 8;
const MAX_DEVICES = 8;
const MAX_CONNECTIONS = 32;
const MAX_RATE_BUCKETS = 64;
const API_BODY_BYTES = 100_000;
const PAIRING_BODY_BYTES = 4_096;
const MAX_POLL_BYTES = REMOTE_CONTROL_LIMITS.maxQueueBytes;
const REQUEST_TIMEOUT_MS = 5_000;
const CONTROL_PREFIX = "/api/control/";
const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
});

export interface PrivateControlHttpsConfig {
  /** Literal loopback, RFC1918, link-local, ULA or CGNAT address; never 0.0.0.0/::. */
  readonly bindAddress: string;
  /** Zero is allowed for a test/local ephemeral listener; publicOrigin must then use :0. */
  readonly port: number;
  /** Exact browser origin, including the configured port. Its DNS must resolve privately. */
  readonly publicOrigin: string;
  readonly tlsCertPath: string;
  readonly tlsKeyPath: string;
  /** Only built, allowlisted static assets are loaded. No filesystem path is accepted remotely. */
  readonly webRoot: string;
}

export interface PrivateControlPairingInvitation {
  readonly code: string;
  readonly expiresAt: number;
}

export interface PrivateControlPendingPairing {
  readonly pairingId: string;
  readonly deviceId: string;
  readonly label: string;
  readonly expiresAt: number;
}

export interface PrivateControlDevice {
  readonly deviceId: string;
  readonly label: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface PrivateControlHttpsSnapshot {
  readonly enabled: boolean;
  readonly starting: boolean;
  readonly origin?: string;
  readonly invitationExpiresAt?: number;
  /** Only proof-verified devices awaiting a local desktop decision appear here. */
  readonly pendingPairings: readonly PrivateControlPendingPairing[];
  readonly devices: readonly PrivateControlDevice[];
}

export interface PrivateControlHttpsHostOptions {
  readonly controlService: RemoteControlService;
  readonly onStateChange?: (state: PrivateControlHttpsSnapshot) => void;
  readonly now?: () => number;
}

export class PrivateControlHttpsError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = "PrivateControlHttpsError";
  }
}

interface Invitation { hash: Buffer; expiresAt: number; attempts: number }
interface PendingPairing {
  pairingId: string;
  tokenHash: Buffer;
  challenge: PairingChallenge;
  authority: InMemoryPairingAuthority;
  label: string;
  expiresAt: number;
  state: "awaiting_proof" | "pending_confirmation" | "approved" | "rejected";
  grant?: PairingGrant;
}
interface ActiveRoute {
  authority: InMemoryPairingAuthority;
  bridge: HostBridge;
  outbox: HttpRouteOutbox;
  device: PrivateControlDevice;
}
interface Asset { bytes: Buffer; type: string }
interface RateBucket { window: number; api: number; pairing: number }
interface EnabledState {
  readonly generation: number;
  readonly hostId: string;
  readonly server: Server;
  readonly origin: string;
  readonly host: string;
  readonly assets: ReadonlyMap<string, Asset>;
  readonly pending: Map<string, PendingPairing>;
  readonly routes: Map<string, ActiveRoute>;
  readonly rates: Map<string, RateBucket>;
  readonly sockets: Set<Socket>;
  invitation?: Invitation;
  active: boolean;
}

/**
 * A private HTTPS endpoint for the desktop's existing control service. No local
 * admin operation is exposed over HTTP. Every enable creates a new host epoch;
 * credentials and replay high-water marks share the same in-memory lifetime.
 */
export class PrivateControlHttpsHost {
  readonly #options: PrivateControlHttpsHostOptions;
  readonly #now: () => number;
  #state: EnabledState | undefined;
  #generation = 0;
  #starting = false;
  #opening: Promise<void> | undefined;

  constructor(options: PrivateControlHttpsHostOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  snapshot(): PrivateControlHttpsSnapshot {
    const state = this.#state;
    if (!state?.active) return { enabled: false, starting: this.#starting, pendingPairings: [], devices: [] };
    this.#purge(state);
    return {
      enabled: true,
      starting: this.#starting,
      origin: state.origin,
      ...(state.invitation ? { invitationExpiresAt: state.invitation.expiresAt } : {}),
      pendingPairings: [...state.pending.values()]
        .filter((pending) => pending.state === "pending_confirmation")
        .map((pending) => ({
          pairingId: pending.pairingId,
          deviceId: pending.challenge.deviceId,
          label: pending.label,
          expiresAt: pending.expiresAt,
        })),
      devices: [...state.routes.values()].map((route) => ({ ...route.device })),
    };
  }

  async enable(config: PrivateControlHttpsConfig): Promise<PrivateControlHttpsSnapshot> {
    if (this.#state || this.#starting || this.#opening) fail("already_enabled", "Remote control is already enabled or starting.");
    let finishOpening!: () => void;
    const opening = new Promise<void>((finish) => { finishOpening = finish; });
    this.#opening = opening;
    this.#starting = true;
    const generation = ++this.#generation;
    this.#notify();
    let server: Server | undefined;
    try {
      const origin = await validateConfig(config);
      const [cert, key, assets] = await Promise.all([
        readFile(config.tlsCertPath), readFile(config.tlsKeyPath), loadAssets(config.webRoot),
      ]);
      if (generation !== this.#generation) fail("remote_disabled", "Remote control was disabled.", 410);
      server = createServer({ cert, key, minVersion: "TLSv1.2", maxHeaderSize: 8_192 });
      server.requestTimeout = REQUEST_TIMEOUT_MS;
      server.headersTimeout = REQUEST_TIMEOUT_MS;
      server.keepAliveTimeout = 1_000;
      server.maxRequestsPerSocket = 100;
      server.maxConnections = MAX_CONNECTIONS;
      server.on("tlsClientError", () => { /* Untrusted or malformed clients never enter HTTP. */ });
      server.on("clientError", (_error, socket) => { socket.destroy(); });
      await new Promise<void>((accept, reject) => {
        const onError = (error: Error): void => { reject(error); };
        server!.once("error", onError);
        server!.listen(config.port, config.bindAddress, () => {
          server!.off("error", onError);
          accept();
        });
      });
      if (generation !== this.#generation) fail("remote_disabled", "Remote control was disabled.", 410);
      const address = server.address();
      if (!address || typeof address === "string") fail("listen_failed", "The private HTTPS listener could not start.");
      origin.port = String(address.port);
      const state: EnabledState = {
        generation, hostId: `host_${randomBytes(18).toString("base64url")}`, server,
        origin: origin.origin, host: origin.host, assets,
        pending: new Map(), routes: new Map(), rates: new Map(), sockets: new Set(), active: true,
      };
      this.#state = state;
      server.on("connection", (socket: Socket) => {
        state.sockets.add(socket);
        socket.setTimeout(10_000, () => { socket.destroy(); });
        socket.once("close", () => { state.sockets.delete(socket); });
      });
      server.on("request", (request, response) => {
        void this.#request(state, request, response);
      });
      // Runtime socket errors fail closed instead of leaving a UI that claims the listener is live.
      server.on("error", () => { if (this.#state === state) void this.disable(); });
      this.#starting = false;
      this.#notify();
      return this.snapshot();
    } catch (error) {
      if (server?.listening) {
        server.closeAllConnections();
        await new Promise<void>((accept) => { server!.close(() => { accept(); }); });
      }
      this.#starting = false;
      this.#notify();
      if (error instanceof PrivateControlHttpsError) throw error;
      throw new PrivateControlHttpsError("setup_failed", "Cannot start HTTPS. Check the private address, TLS certificate/key, port and control-web build.");
    } finally {
      finishOpening();
      if (this.#opening === opening) this.#opening = undefined;
    }
  }

  /** Revocation is synchronous before the returned close promise can yield. */
  async disable(): Promise<void> {
    ++this.#generation;
    this.#starting = false;
    const state = this.#state;
    const opening = this.#opening;
    this.#state = undefined;
    if (!state) { this.#notify(); await opening; return; }
    state.active = false;
    delete state.invitation;
    for (const route of state.routes.values()) {
      route.authority.revokeDevice(route.device.deviceId);
      route.bridge.disconnect();
      route.outbox.clear();
    }
    for (const pending of state.pending.values()) this.#discardPending(pending);
    state.routes.clear();
    state.pending.clear();
    state.rates.clear();
    this.#notify();
    for (const socket of state.sockets) socket.destroy();
    state.server.closeAllConnections();
    await new Promise<void>((accept) => { state.server.close(() => { accept(); }); });
    await opening;
  }

  createPairing(): PrivateControlPairingInvitation {
    const state = this.#enabled();
    this.#purge(state);
    if (state.routes.size >= MAX_DEVICES || state.pending.size >= MAX_PAIRINGS) {
      fail("limit_exceeded", "Revoke an old device or wait for pending pairings to expire.", 429);
    }
    const code = randomBytes(8).toString("hex").toUpperCase();
    const expiresAt = this.#now() + PAIRING_TTL_MS;
    state.invitation = { hash: digest(code), expiresAt, attempts: 0 };
    this.#notify();
    return { code, expiresAt };
  }

  approvePairing(pairingId: string): void {
    const state = this.#enabled();
    this.#purge(state);
    const pending = state.pending.get(pairingId);
    if (!pending || pending.state !== "pending_confirmation" || !pending.grant) {
      fail("pairing_invalid", "The pairing request expired or is no longer awaiting approval.");
    }
    if (state.routes.size >= MAX_DEVICES) fail("limit_exceeded", "Revoke an old device before approving another.", 429);
    const grant = pending.grant;
    // The desktop confirmation binds exactly the proved key/device, never caller-supplied capabilities.
    const outbox = new HttpRouteOutbox(grant.channel.routeId);
    const bridge = new HostBridge({
      hostId: state.hostId, routeId: grant.channel.routeId,
      credentials: pending.authority, codec: pending.authority,
      controlService: this.#options.controlService, now: this.#now,
    });
    bridge.connect(outbox);
    state.routes.set(grant.channel.routeId, {
      authority: pending.authority, bridge, outbox,
      device: { deviceId: grant.deviceId, label: pending.label, issuedAt: grant.issuedAt, expiresAt: grant.expiresAt },
    });
    pending.state = "approved";
    this.#notify();
  }

  rejectPairing(pairingId: string): void {
    const state = this.#enabled();
    const pending = state.pending.get(pairingId);
    if (!pending || pending.state === "approved") fail("pairing_invalid", "The pairing request is no longer awaiting approval.");
    this.#discardPending(pending);
    pending.state = "rejected";
    this.#notify();
  }

  revokeDevice(deviceId: string): void {
    const state = this.#enabled();
    for (const [routeId, route] of state.routes) {
      if (route.device.deviceId !== deviceId) continue;
      route.authority.revokeDevice(deviceId);
      route.bridge.disconnect();
      route.outbox.clear();
      state.routes.delete(routeId);
    }
    for (const [pairingId, pending] of state.pending) {
      if (pending.challenge.deviceId !== deviceId) continue;
      this.#discardPending(pending);
      state.pending.delete(pairingId);
    }
    this.#notify();
  }

  #enabled(): EnabledState {
    if (!this.#state?.active) fail("remote_disabled", "Enable remote control on the desktop first.", 410);
    return this.#state;
  }

  #notify(): void {
    try { this.#options.onStateChange?.(this.snapshot()); } catch { /* Observers do not own lifecycle. */ }
  }

  #discardPending(pending: PendingPairing): void {
    pending.authority.revokeDevice(pending.challenge.deviceId);
    delete pending.grant;
  }

  #purge(state: EnabledState): void {
    const now = this.#now();
    if (state.invitation && now >= state.invitation.expiresAt) delete state.invitation;
    for (const [id, pending] of state.pending) {
      if (now < pending.expiresAt) continue;
      const route = state.routes.get(pending.challenge.routeId);
      if (route && pending.state === "approved") {
        route.bridge.disconnect();
        route.outbox.clear();
        state.routes.delete(pending.challenge.routeId);
      }
      this.#discardPending(pending);
      state.pending.delete(id);
    }
    for (const [id, route] of state.routes) {
      if (now < route.device.expiresAt) continue;
      route.authority.revokeDevice(route.device.deviceId);
      route.bridge.disconnect();
      route.outbox.clear();
      state.routes.delete(id);
    }
  }

  async #request(state: EnabledState, request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; worker-src 'none'");
    try {
      this.#assertCurrent(state);
      assertRequestOrigin(request, state);
      const path = request.url;
      if (!path || path.length > 1_024 || path.includes("?") || path.includes("#")) fail("invalid_request", "Unknown request path.", 404);
      if (!path.startsWith("/api/")) {
        if (request.method !== "GET" && request.method !== "HEAD") fail("invalid_request", "Method not allowed.", 405);
        const asset = state.assets.get(path === "/" ? "/index.html" : path);
        if (!asset) fail("invalid_request", "Unknown resource.", 404);
        response.statusCode = 200;
        response.setHeader("Content-Type", asset.type);
        response.setHeader("Content-Length", asset.bytes.byteLength);
        response.end(request.method === "HEAD" ? undefined : asset.bytes);
        return;
      }
      if (request.method !== "POST") fail("invalid_request", "API requests require POST.", 405);
      if (request.headers.origin !== state.origin) fail("origin_forbidden", "The request origin is not allowed.", 403);
      this.#rateLimit(state, request, !path.startsWith(CONTROL_PREFIX));
      this.#purge(state);
      const body = await readJsonBody(request, path.startsWith(CONTROL_PREFIX) ? API_BODY_BYTES : PAIRING_BODY_BYTES);
      this.#assertCurrent(state);
      switch (path) {
        case "/api/pairing/begin": {
          fields(body, ["pairingCode", "deviceId", "publicKey", "label"]);
          const invitation = state.invitation;
          if (!invitation || this.#now() >= invitation.expiresAt) fail("pairing_expired", "Create a new pairing code on the desktop.", 410);
          const pairingCode = textField(body.pairingCode, 32).replace(/[ -]/gu, "").toUpperCase();
          if (!safeDigestEqual(invitation.hash, pairingCode)) {
            invitation.attempts += 1;
            if (invitation.attempts >= 5) delete state.invitation;
            fail("pairing_invalid", "The pairing code is invalid or expired.", 403);
          }
          if (state.pending.size >= MAX_PAIRINGS || state.routes.size >= MAX_DEVICES) fail("limit_exceeded", "Too many paired devices or pending pairings.", 429);
          const authority = new InMemoryPairingAuthority({
            hostId: state.hostId, allowedCapabilities: REMOTE_CONTROL_CAPABILITIES, clock: this.#now,
            pairingNonceTtlMs: PAIRING_TTL_MS, credentialTtlMs: CREDENTIAL_TTL_MS,
            maxPendingPairings: 1, maxActiveChannels: 1, maxCredentialRecords: 1,
          });
          const challenge = authority.beginPairing({
            deviceId: textField(body.deviceId, 128), publicKey: textField(body.publicKey, 128),
            grantedCapabilities: REMOTE_CONTROL_CAPABILITIES,
          });
          const pairingId = `pairing_${randomBytes(18).toString("base64url")}`;
          const pairingToken = randomBytes(32).toString("base64url");
          const label = body.label === undefined ? "Phone browser" : textField(body.label, 48);
          state.pending.set(pairingId, {
            pairingId, tokenHash: digest(pairingToken), challenge, authority, label,
            expiresAt: challenge.expiresAt, state: "awaiting_proof",
          });
          delete state.invitation;
          this.#notify();
          json(response, 200, { pairingId, pairingToken, challenge, expiresAt: challenge.expiresAt });
          return;
        }
        case "/api/pairing/prove": {
          fields(body, ["pairingId", "pairingToken", "proof"]);
          const pending = this.#pending(state, body);
          if (pending.state !== "awaiting_proof") fail("pairing_invalid", "The pairing proof was already submitted.");
          const proof = record(body.proof);
          fields(proof, ["version", "nonce", "signature"]);
          if (proof.version !== 1) fail("invalid_request", "Unsupported pairing proof version.");
          pending.grant = pending.authority.completePairing({
            version: 1, nonce: textField(proof.nonce, 128), signature: textField(proof.signature, 128),
          } satisfies PairingProof);
          pending.state = "pending_confirmation";
          this.#notify();
          json(response, 200, { status: "pending_confirmation" });
          return;
        }
        case "/api/pairing/poll": {
          fields(body, ["pairingId", "pairingToken"]);
          const pending = this.#pending(state, body);
          if (pending.state === "rejected") fail("pairing_rejected", "The desktop rejected this pairing request.", 403);
          if (pending.state === "approved" && pending.grant) {
            const grant = pending.grant;
            // Delivery is intentionally once-only. Lost delivery/page refresh requires a new pairing.
            delete pending.grant;
            state.pending.delete(pending.pairingId);
            json(response, 200, { status: "approved", grant });
            return;
          }
          if (pending.state !== "pending_confirmation") fail("pairing_invalid", "Submit a valid pairing proof first.");
          json(response, 200, { status: "pending_confirmation" });
          return;
        }
        case "/api/control/send": {
          fields(body, ["deviceId", "routeId", "envelope"]);
          const route = this.#authorize(state, request, body);
          const envelope = decodeWireEnvelope(body.envelope);
          if (envelope.routeId !== body.routeId || envelope.direction !== "device_to_host") fail("invalid_request", "Envelope route or direction is invalid.");
          const usage = route.bridge.snapshot();
          if (usage.pendingMessages >= REMOTE_CONTROL_LIMITS.maxQueueMessages
            || usage.pendingBytes + envelope.byteLength > REMOTE_CONTROL_LIMITS.maxQueueBytes) {
            fail("limit_exceeded", "The host request queue is full. Reconnect before retrying.", 429);
          }
          // 202 acknowledges transport delivery only. The encrypted ACK establishes operation admission.
          // Never await a snapshot/runtime read here: independent Stop requests must keep arriving.
          void route.bridge.receive(envelope).catch(() => { /* Client reconciles missing ACK/result. */ });
          json(response, 202, { accepted: true });
          return;
        }
        case "/api/control/poll": {
          fields(body, ["deviceId", "routeId"]);
          const route = this.#authorize(state, request, body);
          json(response, 200, { envelopes: route.outbox.drain() });
          return;
        }
        default:
          fail("invalid_request", "Unknown API endpoint.", 404);
      }
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      const safe = safeHttpError(error);
      response.setHeader("Connection", "close");
      json(response, safe.status, { error: { code: safe.code, message: safe.message } });
    }
  }

  #assertCurrent(state: EnabledState): void {
    if (!state.active || this.#state !== state || state.generation !== this.#generation) fail("remote_disabled", "Remote control was disabled. Pair again on the desktop.", 410);
  }

  #pending(state: EnabledState, body: Record<string, unknown>): PendingPairing {
    const id = textField(body.pairingId, 128);
    const token = textField(body.pairingToken, 128);
    const pending = state.pending.get(id);
    if (!pending || !safeDigestEqual(pending.tokenHash, token)) fail("pairing_invalid", "The pairing request is invalid or expired.", 403);
    if (this.#now() >= pending.expiresAt) fail("pairing_expired", "Create a new pairing code on the desktop.", 410);
    return pending;
  }

  #authorize(state: EnabledState, request: IncomingMessage, body: Record<string, unknown>): ActiveRoute {
    const routeId = textField(body.routeId, 128);
    const deviceId = textField(body.deviceId, 128);
    const authorization = request.headers.authorization;
    if (typeof authorization !== "string" || !/^Bearer [A-Za-z0-9_-]{1,512}$/u.test(authorization)) fail("authentication_failed", "Pair this browser with the desktop again.", 401);
    const route = state.routes.get(routeId);
    if (!route || route.device.deviceId !== deviceId) fail("authentication_failed", "This device was revoked or remote control restarted. Pair again.", 401);
    route.authority.authenticate({
      credential: authorization.slice(7), hostId: state.hostId, deviceId, routeId, capability: "sessions.read",
    });
    return route;
  }

  #rateLimit(state: EnabledState, request: IncomingMessage, pairing: boolean): void {
    const now = this.#now();
    const window = Math.floor(now / 60_000);
    const peer = request.socket.remoteAddress ?? "unknown";
    for (const [id, bucket] of state.rates) if (bucket.window !== window) state.rates.delete(id);
    let bucket = state.rates.get(peer);
    if (!bucket) {
      if (state.rates.size >= MAX_RATE_BUCKETS) fail("limit_exceeded", "Too many clients. Try again later.", 429);
      bucket = { window, api: 0, pairing: 0 };
      state.rates.set(peer, bucket);
    }
    bucket.api += 1;
    if (pairing) bucket.pairing += 1;
    if (bucket.api > 600 || bucket.pairing > 120) fail("limit_exceeded", "Too many requests. Try again later.", 429);
  }
}

/** An actual HTTPS outbox transport: bounded, synchronous and scoped to one approved route. */
class HttpRouteOutbox implements HostBridgeRelay {
  readonly limits = Object.freeze({
    maxMessageBytes: REMOTE_CONTROL_LIMITS.maxCiphertextBytes,
    maxQueuedMessagesPerRoute: REMOTE_CONTROL_LIMITS.maxQueueMessages,
    maxQueuedBytesPerRoute: REMOTE_CONTROL_LIMITS.maxQueueBytes,
  });
  readonly #routeId: string;
  readonly #queue: { envelope: WireRelayEnvelope; bytes: number }[] = [];
  #bytes = 0;
  #connected = false;

  constructor(routeId: string) { this.#routeId = routeId; }

  connectHost(options: { routeId: string; onMessage(envelope: OpaqueRelayEnvelope): void }) {
    if (options.routeId !== this.#routeId || this.#connected) throw new Error("Route binding failed");
    this.#connected = true;
    const self = this;
    return {
      get connected() { return self.#connected; },
      routeId: this.#routeId,
      send: (envelope: OpaqueRelayEnvelope): void => { this.#push(envelope); },
      disconnect: (): void => { this.#connected = false; this.clear(); },
    };
  }

  clear(): void { this.#queue.length = 0; this.#bytes = 0; }

  drain(): WireRelayEnvelope[] {
    const result = this.#queue.map((item) => item.envelope);
    this.clear();
    return result;
  }

  #push(envelope: OpaqueRelayEnvelope): void {
    if (!this.#connected || envelope.routeId !== this.#routeId || envelope.direction !== "host_to_device") throw new Error("Route unavailable");
    const wire = encodeWireEnvelope(envelope);
    const bytes = Buffer.byteLength(JSON.stringify(wire), "utf8");
    // Include JSON wrapper, commas and every serialized envelope byte, not only ciphertext bytes.
    if (this.#queue.length >= this.limits.maxQueuedMessagesPerRoute
      || this.#bytes + bytes + this.#queue.length + 32 > MAX_POLL_BYTES) throw new Error("Route outbox full");
    this.#queue.push({ envelope: wire, bytes });
    this.#bytes += bytes;
  }
}

async function validateConfig(config: PrivateControlHttpsConfig): Promise<URL> {
  if (!isPrivateAddress(config.bindAddress)) fail("invalid_bind_address", "Bind to a specific private or loopback IP address; wildcard/public listeners are not allowed.");
  if (!Number.isSafeInteger(config.port) || config.port < 0 || config.port > 65_535) fail("invalid_port", "The HTTPS port must be between 0 and 65535.");
  let url: URL;
  try { url = new URL(config.publicOrigin); } catch { fail("invalid_origin", "Enter an HTTPS origin with the private host and port."); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || url.origin !== config.publicOrigin || Number(url.port || 443) !== config.port) {
    fail("invalid_origin", "Use an exact HTTPS origin matching the listener port, without a path or credentials.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  if (isIP(hostname)) {
    if (!isPrivateAddress(hostname)) fail("invalid_origin", "The HTTPS host must be a private address.");
  } else {
    const addresses = await lookup(hostname, { all: true });
    if (addresses.length === 0 || addresses.some(({ address }) => !isPrivateAddress(address))) fail("invalid_origin", "The HTTPS hostname must resolve only to private addresses.");
  }
  return url;
}

/** Fail closed for public, wildcard, multicast and IPv4-mapped public listeners. */
export function isPrivateControlAddress(address: string): boolean { return isPrivateAddress(address); }

function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a = -1, b = -1] = address.split(".").map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    if (normalized === "::1") return true;
    if (normalized.startsWith("::ffff:")) return isPrivateAddress(normalized.slice(7));
    return /^(?:fc|fd)[0-9a-f]{2}:/u.test(normalized) || /^fe[89ab][0-9a-f]:/u.test(normalized);
  }
  return false;
}

function assertRequestOrigin(request: IncomingMessage, state: EnabledState): void {
  const names = request.rawHeaders.filter((_value, index) => index % 2 === 0).map((name) => name.toLowerCase());
  if (names.filter((name) => name === "host").length !== 1
    || names.filter((name) => name === "origin").length > 1
    || names.filter((name) => name === "authorization").length > 1
    || request.headers.host !== state.host) fail("host_forbidden", "The request host is not allowed.", 403);
  if (request.headers.origin !== undefined && request.headers.origin !== state.origin) fail("origin_forbidden", "The request origin is not allowed.", 403);
  const site = request.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") fail("origin_forbidden", "Cross-origin requests are not allowed.", 403);
}

async function loadAssets(rootInput: string): Promise<ReadonlyMap<string, Asset>> {
  const root = await realpath(resolve(rootInput));
  const result = new Map<string, Asset>();
  let total = 0;
  let entries = 0;
  async function visit(directory: string, depth = 0): Promise<void> {
    if (depth > 8) fail("invalid_web_root", "The control-web build has too many directory levels.");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      entries += 1;
      if (entries > 256) fail("invalid_web_root", "The control-web build has too many directory entries.");
      const filename = join(directory, entry.name);
      if (entry.isSymbolicLink()) fail("invalid_web_root", "The control-web build must not contain symlinks.");
      if (entry.isDirectory()) { await visit(filename, depth + 1); continue; }
      if (!entry.isFile()) continue;
      const type = MIME_TYPES[extname(filename)];
      if (!type) continue;
      const path = relative(root, filename).split(sep).join("/");
      if (!/^[A-Za-z0-9_./-]+$/u.test(path) || path.startsWith("../")) fail("invalid_web_root", "The control-web build contains an unsupported asset path.");
      const size = (await stat(filename)).size;
      if (size > 2_097_152 || total + size > 8_388_608 || result.size >= 128) fail("invalid_web_root", "The control-web build exceeds its asset limit.");
      const bytes = await readFile(filename);
      total += bytes.byteLength;
      result.set(`/${path}`, { type, bytes });
    }
  }
  await visit(root);
  if (!result.has("/index.html")) fail("invalid_web_root", "Build apps/control-web before enabling remote control.");
  return result;
}

function readJsonBody(request: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  if (request.headers["content-type"] !== "application/json") fail("invalid_request", "API requests require application/json.", 415);
  if (request.headers["content-encoding"] !== undefined) fail("invalid_request", "Compressed request bodies are not supported.", 415);
  const length = request.headers["content-length"];
  if (length !== undefined && (!/^\d+$/u.test(length) || Number(length) > limit)) fail("limit_exceeded", "Request body is too large.", 413);
  return new Promise((accept, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => { cleanup(); reject(new PrivateControlHttpsError("request_timeout", "Request body timed out.", 408)); }, REQUEST_TIMEOUT_MS);
    timer.unref();
    const cleanup = (): void => { clearTimeout(timer); request.off("data", onData); request.off("end", onEnd); request.off("error", onError); request.off("aborted", onAborted); };
    const onError = (): void => { cleanup(); reject(new PrivateControlHttpsError("invalid_request", "Request body could not be read.")); };
    const onAborted = (): void => { onError(); };
    const onData = (chunk: Buffer): void => {
      size += chunk.byteLength;
      if (size > limit) { cleanup(); request.pause(); reject(new PrivateControlHttpsError("limit_exceeded", "Request body is too large.", 413)); return; }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      try { accept(record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))))); }
      catch { reject(new PrivateControlHttpsError("invalid_request", "Request body must be a UTF-8 JSON object.")); }
    };
    request.on("data", onData); request.once("end", onEnd); request.once("error", onError); request.once("aborted", onAborted);
  });
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("invalid_request", "Expected a JSON object.");
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail("invalid_request", "The request contains unsupported fields.");
}
function textField(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) fail("invalid_request", "The request contains an invalid text field.");
  return value;
}
function digest(value: string): Buffer { return createHash("sha256").update(value).digest(); }
function safeDigestEqual(expected: Buffer, value: string): boolean { return timingSafeEqual(expected, digest(value)); }
function fail(code: string, message: string, status = 400): never { throw new PrivateControlHttpsError(code, message, status); }
function json(response: ServerResponse, status: number, value: unknown): void {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > MAX_POLL_BYTES) fail("limit_exceeded", "The response exceeded the byte limit.", 500);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(serialized));
  response.end(serialized);
}
function safeHttpError(error: unknown): PrivateControlHttpsError {
  if (error instanceof PrivateControlHttpsError) return error;
  if (error instanceof PairingSecurityError) {
    if (error.code.startsWith("CREDENTIAL_")) return new PrivateControlHttpsError("authentication_failed", "Device authorization expired or was revoked. Pair again.", 401);
    return new PrivateControlHttpsError("pairing_invalid", "The pairing proof or device identity is invalid.", 403);
  }
  return new PrivateControlHttpsError("invalid_request", "The request could not be accepted.");
}
