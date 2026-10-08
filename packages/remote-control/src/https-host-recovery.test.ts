import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RemoteControlService } from "./host-bridge.js";
import { decodeWireEnvelope, encodeWireEnvelope } from "./http-wire.js";
import { PrivateControlHttpsHost } from "./https-host.js";
import {
  createPairingProof, generateDeviceIdentity, openRelayEnvelope, sealRelayEnvelope,
  type DeviceIdentity, type PairingChallenge, type PairingGrant,
} from "./pairing-security.js";
import { parseOpaqueRelayEnvelope, type RemoteControlFrame } from "./protocol.js";

const TRUST_TTL_MS = 8 * 60 * 60 * 1_000;
const nativeHeaders = { "x-chili-control-client": "native-v1" };
let directory: string;
let certificate: Buffer;
let certPath: string;
let keyPath: string;
const hosts: PrivateControlHttpsHost[] = [];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "chili-https-recovery-unit-"));
  certPath = join(directory, "certificate.pem");
  keyPath = join(directory, "key.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath,
    "-out", certPath, "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ], { stdio: "ignore" });
  certificate = await readFile(certPath);
  await writeFile(join(directory, "index.html"), "<!doctype html><title>Recovery fixture</title>");
});
afterEach(async () => { await Promise.all(hosts.splice(0).map((value) => value.disable())); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

function host(now?: () => number, service: RemoteControlService = { invoke: () => ({ sessions: [] }) }): PrivateControlHttpsHost {
  const value = new PrivateControlHttpsHost({ controlService: service, ...(now ? { now } : {}) });
  hosts.push(value);
  return value;
}

async function enable(value: PrivateControlHttpsHost): Promise<string> {
  const state = await value.enable({
    bindAddress: "127.0.0.1", port: 0, publicOrigin: "https://127.0.0.1:0",
    tlsCertPath: certPath, tlsKeyPath: keyPath, webRoot: directory,
  });
  return state.origin!;
}

interface HttpOptions { omitOrigin?: boolean; trusted?: boolean; headers?: Record<string, string> }
interface HttpResult { status: number; body: unknown }
function http(origin: string, path: string, body: unknown, options: HttpOptions = {}): Promise<HttpResult> {
  return new Promise((accept, reject) => {
    const data = JSON.stringify(body);
    const request = httpsRequest(new URL(path, origin), {
      ...(options.trusted === false ? {} : { ca: certificate }),
      method: "POST", agent: false, servername: "localhost",
      headers: {
        "content-type": "application/json", "content-length": String(Buffer.byteLength(data)),
        ...(!options.omitOrigin ? { origin } : {}), ...options.headers,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => { chunks.push(chunk); });
      response.on("end", () => {
        try {
          accept({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown });
        } catch (error) { reject(error); }
      });
      response.on("error", reject);
    });
    request.once("error", reject);
    request.end(data);
  });
}

interface BeginResult { pairingId: string; pairingToken: string; challenge: PairingChallenge; expiresAt: number }
interface Recovery { version: 1; hostId: string; deviceId: string; publicKey: string; expiresAt: number }
interface Approved { status: "approved"; grant: PairingGrant; recovery?: Recovery }

async function beginPairing(value: PrivateControlHttpsHost, origin: string, rememberDevice?: boolean, options: HttpOptions = {}) {
  const identity = generateDeviceIdentity();
  const invitation = value.createPairing();
  const response = await http(origin, "/api/pairing/begin", {
    pairingCode: invitation.code, deviceId: identity.deviceId, publicKey: identity.publicKey, label: "Recovery phone",
    ...(rememberDevice === undefined ? {} : { rememberDevice }),
  }, options);
  expect(response.status).toBe(200);
  return { ...(response.body as BeginResult), identity };
}

function identifiers(pending: BeginResult) { return { pairingId: pending.pairingId, pairingToken: pending.pairingToken }; }

async function provePairing(origin: string, pending: BeginResult & { identity: DeviceIdentity }, options: HttpOptions = {}) {
  const response = await http(origin, "/api/pairing/prove", {
    ...identifiers(pending), proof: createPairingProof(pending.challenge, pending.identity.privateKey),
  }, options);
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ status: "pending_confirmation" });
}

async function collectGrant(value: PrivateControlHttpsHost, origin: string, pending: BeginResult, options: HttpOptions = {}): Promise<Approved> {
  value.approvePairing(pending.pairingId);
  const response = await http(origin, "/api/pairing/poll", identifiers(pending), options);
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ status: "approved" });
  return response.body as Approved;
}

async function pair(value: PrivateControlHttpsHost, origin: string, rememberDevice?: boolean, options: HttpOptions = {}) {
  const pending = await beginPairing(value, origin, rememberDevice, options);
  await provePairing(origin, pending, options);
  return { ...await collectGrant(value, origin, pending, options), identity: pending.identity };
}

function recoveryIdentity(recovery: Recovery) {
  return { hostId: recovery.hostId, deviceId: recovery.deviceId, publicKey: recovery.publicKey };
}

async function beginRecovery(origin: string, recovery: Recovery, options: HttpOptions = {}): Promise<BeginResult> {
  const response = await http(origin, "/api/recovery/begin", recoveryIdentity(recovery), options);
  expect(response.status).toBe(200);
  const pending = response.body as BeginResult;
  expect(pending.challenge).toMatchObject(recoveryIdentity(recovery));
  return pending;
}

async function recover(origin: string, recovery: Recovery, identity: DeviceIdentity, options: HttpOptions = {}): Promise<Approved> {
  const pending = await beginRecovery(origin, recovery, options);
  const response = await http(origin, "/api/recovery/prove", {
    ...identifiers(pending), proof: createPairingProof(pending.challenge, identity.privateKey),
  }, options);
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ status: "approved" });
  return response.body as Approved;
}

function target(grant: PairingGrant) { return { deviceId: grant.deviceId, routeId: grant.channel.routeId }; }
function auth(grant: PairingGrant) { return { authorization: `Bearer ${grant.credential}` }; }
function poll(origin: string, grant: PairingGrant, options: HttpOptions = {}) {
  return http(origin, "/api/control/poll", target(grant), { ...options, headers: { ...options.headers, ...auth(grant) } });
}

async function readSessions(origin: string, grant: PairingGrant): Promise<void> {
  const frame = {
    version: 1, type: "request", hostId: grant.hostId, sessionId: "recovery_stream", deviceId: grant.deviceId,
    credential: grant.credential, sequence: 1, requestId: "recovery_request_1", capability: "sessions.read",
    operation: "sessions.list", payload: {},
  };
  const envelope = encodeWireEnvelope(parseOpaqueRelayEnvelope(sealRelayEnvelope(grant.channel, "device_to_host", frame)));
  expect((await http(origin, "/api/control/send", { ...target(grant), envelope }, { headers: auth(grant) })).status).toBe(202);
  const frames: RemoteControlFrame[] = [];
  for (let attempt = 0; attempt < 30 && frames.length < 2; attempt += 1) {
    const response = await poll(origin, grant);
    expect(response.status).toBe(200);
    frames.push(...(response.body as { envelopes: unknown[] }).envelopes.map((wire) => openRelayEnvelope<RemoteControlFrame>(
      grant.channel, decodeWireEnvelope(wire), { expectedDirection: "host_to_device" },
    )));
    if (frames.length < 2) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(frames.map((result) => result.type)).toEqual(["ack", "result"]);
}

test("remembered recovery requires local approval and rotates route, credentials, key and sequence state", async () => {
  let now = Date.now();
  const value = host(() => now);
  const origin = await enable(value);
  const pending = await beginPairing(value, origin, true);
  await provePairing(origin, pending);
  expect((await http(origin, "/api/recovery/begin", {
    hostId: pending.challenge.hostId, deviceId: pending.identity.deviceId, publicKey: pending.identity.publicKey,
  })).status).toBe(403);
  const first = await collectGrant(value, origin, pending);
  expect(first.recovery).toEqual({
    version: 1, hostId: first.grant.hostId, deviceId: pending.identity.deviceId,
    publicKey: pending.identity.publicKey, expiresAt: now + TRUST_TTL_MS,
  });
  await readSessions(origin, first.grant);
  now += 1_000;
  const next = await recover(origin, first.recovery!, pending.identity);
  expect(next.grant.hostId).toBe(first.grant.hostId);
  expect(next.grant.deviceId).toBe(first.grant.deviceId);
  expect(next.grant.channel.routeId).not.toBe(first.grant.channel.routeId);
  expect(next.grant.channel.key).not.toBe(first.grant.channel.key);
  expect(next.grant.credential).not.toBe(first.grant.credential);
  expect(next.grant.capabilities).toEqual(first.grant.capabilities);
  expect(next.recovery).toEqual(first.recovery);
  expect(next.grant.expiresAt).toBe(first.recovery!.expiresAt);
  expect((await poll(origin, first.grant)).status).toBe(401);
  await readSessions(origin, next.grant);
  expect(value.snapshot().devices).toHaveLength(1);
  const snapshot = JSON.stringify(value.snapshot());
  for (const secret of [pending.identity.privateKey, next.grant.credential, next.grant.channel.key]) expect(snapshot).not.toContain(secret);
});

test("invalid recovery proof and token leave the active route usable; successful proof cannot replay", async () => {
  const value = host();
  const origin = await enable(value);
  const first = await pair(value, origin, true);
  const pending = await beginRecovery(origin, first.recovery!);
  const proof = createPairingProof(pending.challenge, first.identity.privateKey);
  expect((await http(origin, "/api/recovery/prove", { ...identifiers(pending), pairingToken: "wrong", proof })).status).toBe(403);
  expect((await http(origin, "/api/recovery/prove", {
    ...identifiers(pending), proof: createPairingProof(pending.challenge, generateDeviceIdentity().privateKey),
  })).status).toBe(403);
  await readSessions(origin, first.grant);
  const response = await http(origin, "/api/recovery/prove", { ...identifiers(pending), proof });
  expect(response.status).toBe(200);
  const next = response.body as Approved;
  expect((await http(origin, "/api/recovery/prove", { ...identifiers(pending), proof })).status).toBe(403);
  expect((await poll(origin, first.grant)).status).toBe(401);
  expect((await poll(origin, next.grant)).status).toBe(200);
});

test("trust survives an expired initial channel but recovery never extends its original eight-hour deadline", async () => {
  let now = Date.now();
  const value = host(() => now);
  const origin = await enable(value);
  const pending = await beginPairing(value, origin, true);
  await provePairing(origin, pending);
  now += 30_000;
  const first = await collectGrant(value, origin, pending);
  expect(first.recovery!.expiresAt).toBe(now + TRUST_TTL_MS);
  now = first.grant.expiresAt + 1;
  expect(now).toBeLessThan(first.recovery!.expiresAt);
  expect((await poll(origin, first.grant)).status).toBe(401);
  expect(value.snapshot().devices).toHaveLength(1);
  expect(value.snapshot().devices[0]).toMatchObject({ deviceId: first.grant.deviceId, expiresAt: first.recovery!.expiresAt });
  const next = await recover(origin, first.recovery!, pending.identity);
  expect(next.recovery).toEqual(first.recovery);
  expect(next.grant.expiresAt).toBe(first.recovery!.expiresAt);
  expect((await poll(origin, next.grant)).status).toBe(200);
  now = first.recovery!.expiresAt;
  expect(value.snapshot().devices).toHaveLength(0);
  expect((await poll(origin, next.grant)).status).toBe(401);
  expect((await http(origin, "/api/recovery/begin", recoveryIdentity(first.recovery!))).status).toBe(403);
});

test("revocation removes remembered trust and invalidates recovery already awaiting proof", async () => {
  const value = host();
  const origin = await enable(value);
  const first = await pair(value, origin, true);
  const pending = await beginRecovery(origin, first.recovery!);
  value.revokeDevice(first.identity.deviceId);
  expect(value.snapshot().devices).toHaveLength(0);
  expect((await poll(origin, first.grant)).status).toBe(401);
  expect((await http(origin, "/api/recovery/begin", recoveryIdentity(first.recovery!))).status).toBe(403);
  expect((await http(origin, "/api/recovery/prove", {
    ...identifiers(pending), proof: createPairingProof(pending.challenge, first.identity.privateKey),
  })).status).toBe(403);
});

test("recovery started before trust expiry cannot prove after the fixed trust deadline", async () => {
  let now = Date.now();
  const value = host(() => now);
  const origin = await enable(value);
  const first = await pair(value, origin, true);
  now = first.recovery!.expiresAt - 1_000;
  const pending = await beginRecovery(origin, first.recovery!);
  expect(pending.expiresAt).toBeLessThanOrEqual(first.recovery!.expiresAt);
  now = first.recovery!.expiresAt;
  expect((await http(origin, "/api/recovery/prove", {
    ...identifiers(pending), proof: createPairingProof(pending.challenge, first.identity.privateKey),
  })).status).toBe(403);
  expect(value.snapshot().devices).toHaveLength(0);
});

test("recovery proof cannot replace initial desktop approval and pairing endpoints cannot consume recovery", async () => {
  const value = host();
  const origin = await enable(value);
  const initial = await beginPairing(value, origin, true);
  expect((await http(origin, "/api/recovery/prove", {
    ...identifiers(initial), proof: createPairingProof(initial.challenge, initial.identity.privateKey),
  })).status).toBe(403);
  expect(value.snapshot().devices).toHaveLength(0);
  await provePairing(origin, initial);
  const first = await collectGrant(value, origin, initial);
  const pending = await beginRecovery(origin, first.recovery!);
  const proof = createPairingProof(pending.challenge, initial.identity.privateKey);
  expect((await http(origin, "/api/pairing/prove", { ...identifiers(pending), proof })).status).toBe(403);
  expect((await http(origin, "/api/pairing/poll", identifiers(pending))).status).toBe(403);
  expect((await poll(origin, first.grant)).status).toBe(200);
  expect((await http(origin, "/api/recovery/prove", { ...identifiers(pending), proof })).status).toBe(200);
});

test("successful recovery invalidates other outstanding challenges for the same device", async () => {
  const value = host();
  const origin = await enable(value);
  const first = await pair(value, origin, true);
  const stale = await beginRecovery(origin, first.recovery!);
  const next = await recover(origin, first.recovery!, first.identity);
  expect((await http(origin, "/api/recovery/prove", {
    ...identifiers(stale), proof: createPairingProof(stale.challenge, first.identity.privateKey),
  })).status).toBe(403);
  expect((await poll(origin, next.grant)).status).toBe(200);
  expect(value.snapshot().devices).toHaveLength(1);
});

test("disable and re-enable clear remembered trust and change the host epoch", async () => {
  const value = host();
  const origin = await enable(value);
  const first = await pair(value, origin, true);
  const pending = await beginRecovery(origin, first.recovery!);
  await value.disable();
  expect(value.snapshot().devices).toHaveLength(0);
  const nextOrigin = await enable(value);
  expect((await http(nextOrigin, "/api/recovery/begin", recoveryIdentity(first.recovery!))).status).toBe(403);
  expect((await http(nextOrigin, "/api/recovery/prove", {
    ...identifiers(pending), proof: createPairingProof(pending.challenge, first.identity.privateKey),
  })).status).toBe(403);
  expect((await poll(nextOrigin, first.grant)).status).toBe(401);
  const next = await pair(value, nextOrigin, true);
  expect(next.grant.hostId).not.toBe(first.grant.hostId);
});

test("omitted and declined remember preferences and desktop rejection never create recovery trust", async () => {
  const value = host();
  const origin = await enable(value);
  for (const rememberDevice of [undefined, false]) {
    const approved = await pair(value, origin, rememberDevice);
    expect(approved.recovery).toBeUndefined();
    expect((await http(origin, "/api/recovery/begin", {
      hostId: approved.grant.hostId, deviceId: approved.identity.deviceId, publicKey: approved.identity.publicKey,
    })).status).toBe(403);
  }
  const rejected = await beginPairing(value, origin, true);
  await provePairing(origin, rejected);
  value.rejectPairing(rejected.pairingId);
  expect((await http(origin, "/api/recovery/begin", {
    hostId: rejected.challenge.hostId, deviceId: rejected.identity.deviceId, publicKey: rejected.identity.publicKey,
  })).status).toBe(403);
  expect(value.snapshot().devices).toHaveLength(2);
});

test("recovery binds the exact host, device and public key and rejects caller authority fields", async () => {
  const value = host();
  const origin = await enable(value);
  const first = await pair(value, origin, true);
  const expected = recoveryIdentity(first.recovery!);
  const other = generateDeviceIdentity();
  for (const replacement of [{ hostId: "host_wrong" }, { deviceId: other.deviceId }, { publicKey: other.publicKey }]) {
    expect((await http(origin, "/api/recovery/begin", { ...expected, ...replacement })).status).toBe(403);
  }
  expect((await http(origin, "/api/recovery/begin", { ...expected, capabilities: ["admin"] })).status).toBe(400);
  expect((await poll(origin, first.grant)).status).toBe(200);
  const invitation = value.createPairing();
  expect((await http(origin, "/api/pairing/begin", {
    pairingCode: invitation.code, deviceId: other.deviceId, publicKey: other.publicKey, rememberDevice: "true",
  })).status).toBe(400);
});

test("native marker admits trusted TLS without browser headers and does not replace device authentication", async () => {
  const value = host();
  const origin = await enable(value);
  const options = { omitOrigin: true, headers: nativeHeaders };
  await expect(http(origin, "/api/control/poll", { deviceId: "unknown", routeId: "unknown" }, { ...options, trusted: false })).rejects.toThrow();
  expect((await http(origin, "/api/control/poll", { deviceId: "unknown", routeId: "unknown" }, options)).status).toBe(401);
  const first = await pair(value, origin, true, options);
  const next = await recover(origin, first.recovery!, first.identity, options);
  expect((await poll(origin, next.grant, options)).status).toBe(200);
  expect((await poll(origin, first.grant, options)).status).toBe(401);
});

test("native marker rejects Origin and every Sec-Fetch header while unmarked browsers retain same-origin rules", async () => {
  const value = host();
  const origin = await enable(value);
  const first = await pair(value, origin, true);
  expect((await poll(origin, first.grant)).status).toBe(200);
  expect((await poll(origin, first.grant, { headers: { "sec-fetch-site": "same-origin" } })).status).toBe(200);
  expect((await poll(origin, first.grant, { omitOrigin: true })).status).toBe(403);
  expect((await poll(origin, first.grant, { headers: nativeHeaders })).status).toBe(403);
  expect((await poll(origin, first.grant, { headers: { origin: "https://untrusted.example" } })).status).toBe(403);
  expect((await poll(origin, first.grant, { omitOrigin: true, headers: { "x-chili-control-client": "native-v2" } })).status).toBe(403);
  for (const name of ["sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "sec-fetch-user", "sec-fetch-extra"]) {
    expect((await poll(origin, first.grant, { omitOrigin: true, headers: { ...nativeHeaders, [name]: "none" } })).status).toBe(403);
  }
  expect((await poll(origin, first.grant, { omitOrigin: true, headers: { ...nativeHeaders, host: "untrusted.example" } })).status).toBe(403);
});

test("remembered devices remain subject to the eight-device limit when initial channels expire", async () => {
  let now = Date.now();
  const value = host(() => now);
  const origin = await enable(value);
  const remembered: { grant: PairingGrant; recovery?: Recovery; identity: DeviceIdentity }[] = [];
  for (let index = 0; index < 8; index += 1) {
    const pending = await beginPairing(value, origin, true);
    await provePairing(origin, pending);
    now += 1_000;
    remembered.push({ ...await collectGrant(value, origin, pending), identity: pending.identity });
  }
  expect(value.snapshot().devices).toHaveLength(8);
  expect(() => value.createPairing()).toThrow();
  const first = remembered[0]!;
  now = first.grant.expiresAt + 1;
  expect((await poll(origin, first.grant)).status).toBe(401);
  expect(value.snapshot().devices).toHaveLength(8);
  expect(() => value.createPairing()).toThrow();
  const next = await recover(origin, first.recovery!, first.identity);
  expect((await poll(origin, next.grant)).status).toBe(200);
  value.revokeDevice(first.identity.deviceId);
  expect(value.snapshot().devices).toHaveLength(7);
  expect(() => value.createPairing()).not.toThrow();
});

test("pairing and recovery share an eight-pending limit, and expired attempts free capacity", async () => {
  let now = Date.now();
  const value = host(() => now);
  const origin = await enable(value);
  const first = await pair(value, origin, true);
  for (let index = 0; index < 7; index += 1) await beginRecovery(origin, first.recovery!);
  const pairing = await beginPairing(value, origin, true);
  expect((await http(origin, "/api/recovery/begin", recoveryIdentity(first.recovery!))).status).toBe(429);
  expect(() => value.createPairing()).toThrow();
  expect((await poll(origin, first.grant)).status).toBe(200);
  now = pairing.expiresAt;
  expect((await http(origin, "/api/recovery/begin", recoveryIdentity(first.recovery!))).status).toBe(200);
  expect((await poll(origin, first.grant)).status).toBe(200);
});
