import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decodeWireEnvelope, encodeWireEnvelope } from "./http-wire.js";
import { PrivateControlHttpsHost, isPrivateControlAddress } from "./https-host.js";
import type { RemoteControlService } from "./host-bridge.js";
import {
  createPairingProof, generateDeviceIdentity, openRelayEnvelope, sealRelayEnvelope,
  type PairingChallenge, type PairingGrant,
} from "./pairing-security.js";
import { parseOpaqueRelayEnvelope, type RemoteControlFrame, type RemoteControlOperation } from "./protocol.js";

let directory: string;
let certificate: Buffer;
let certPath: string;
let keyPath: string;
const hosts: PrivateControlHttpsHost[] = [];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "chili-private-https-unit-"));
  certPath = join(directory, "certificate.pem");
  keyPath = join(directory, "key.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath,
    "-out", certPath, "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ], { stdio: "ignore" });
  certificate = await readFile(certPath);
  await writeFile(join(directory, "index.html"), "<!doctype html><title>Control TLS fixture</title><p>Private control</p>");
  await writeFile(join(directory, "secret.json"), '{"not":"served"}');
});
afterEach(async () => { await Promise.all(hosts.splice(0).map((host) => host.disable())); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

function host(service: RemoteControlService = { invoke: () => ({ sessions: [] }) }, now?: () => number): PrivateControlHttpsHost {
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
interface HttpResult { status: number; body: unknown; text: string; headers: Record<string, string | string[] | undefined> }
function http(origin: string, path: string, body?: unknown, options: {
  trusted?: boolean; headers?: Record<string, string>; method?: string; omitOrigin?: boolean;
} = {}): Promise<HttpResult> {
  return new Promise((accept, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const request = httpsRequest(new URL(path, origin), {
      ...(options.trusted === false ? {} : { ca: certificate }),
      method: options.method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        ...(data === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(data)) }),
        ...(body !== undefined && !options.omitOrigin ? { origin } : {}),
        ...options.headers,
      },
      agent: false,
      servername: "localhost",
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => { chunks.push(chunk); });
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body: unknown = text;
        try { body = JSON.parse(text); } catch { /* Static assets remain text. */ }
        accept({ status: response.statusCode ?? 0, body, text, headers: response.headers });
      });
      response.on("error", reject);
    });
    request.once("error", reject);
    request.end(data);
  });
}
interface BeginResult { pairingId: string; pairingToken: string; challenge: PairingChallenge; expiresAt: number }
async function begin(value: PrivateControlHttpsHost, origin: string) {
  const identity = generateDeviceIdentity();
  const invitation = value.createPairing();
  const response = await http(origin, "/api/pairing/begin", {
    pairingCode: invitation.code, deviceId: identity.deviceId, publicKey: identity.publicKey, label: "Test phone",
  });
  expect(response.status).toBe(200);
  const pending = response.body as BeginResult;
  return { ...pending, identity, invitation };
}
async function pair(value: PrivateControlHttpsHost, origin: string): Promise<PairingGrant> {
  const pending = await begin(value, origin);
  const proof = createPairingProof(pending.challenge, pending.identity.privateKey);
  expect((await http(origin, "/api/pairing/prove", {
    pairingId: pending.pairingId, pairingToken: pending.pairingToken, proof,
  })).status).toBe(200);
  value.approvePairing(pending.pairingId);
  const response = await http(origin, "/api/pairing/poll", {
    pairingId: pending.pairingId, pairingToken: pending.pairingToken,
  });
  expect(response.status).toBe(200);
  return (response.body as { grant: PairingGrant }).grant;
}
function auth(grant: PairingGrant) { return { authorization: `Bearer ${grant.credential}` }; }
function target(grant: PairingGrant) { return { deviceId: grant.deviceId, routeId: grant.channel.routeId }; }
async function send(origin: string, grant: PairingGrant, sequence: number, operation: RemoteControlOperation, payload: unknown) {
  const frame = {
    version: 1, type: "request", hostId: grant.hostId, sessionId: "browser_stream",
    deviceId: grant.deviceId, credential: grant.credential, sequence,
    requestId: `request_${sequence}`, capability: operation === "session.send" ? "sessions.send" : operation === "session.stop" ? "sessions.stop" : "sessions.read",
    operation, payload,
  };
  const envelope = encodeWireEnvelope(parseOpaqueRelayEnvelope(sealRelayEnvelope(grant.channel, "device_to_host", frame)));
  return await http(origin, "/api/control/send", { ...target(grant), envelope }, { headers: auth(grant) });
}
async function poll(origin: string, grant: PairingGrant): Promise<RemoteControlFrame[]> {
  const response = await http(origin, "/api/control/poll", target(grant), { headers: auth(grant) });
  expect(response.status).toBe(200);
  return (response.body as { envelopes: unknown[] }).envelopes.map((envelope) => openRelayEnvelope<RemoteControlFrame>(
    grant.channel, decodeWireEnvelope(envelope), { expectedDirection: "host_to_device" },
  ));
}
async function untilFrames(origin: string, grant: PairingGrant, length: number): Promise<RemoteControlFrame[]> {
  const frames: RemoteControlFrame[] = [];
  for (let attempt = 0; attempt < 30 && frames.length < length; attempt += 1) {
    frames.push(...await poll(origin, grant));
    if (frames.length < length) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return frames;
}

test("private address policy rejects public and wildcard listeners", () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.2", "100.100.1.2", "169.254.1.1", "::1", "fd12::1", "fe80::1"]) expect(isPrivateControlAddress(address)).toBe(true);
  for (const address of ["0.0.0.0", "::", "8.8.8.8", "172.32.0.1", "100.128.0.1", "::ffff:8.8.8.8", "2001:4860:4860::8888", "localhost"]) expect(isPrivateControlAddress(address)).toBe(false);
});

test("starts disabled; real TLS requires explicit client trust and enforces Host/Origin", async () => {
  const value = host();
  expect(value.snapshot()).toEqual({ enabled: false, starting: false, pendingPairings: [], devices: [] });
  const origin = await enable(value);
  await expect(http(origin, "/", undefined, { trusted: false })).rejects.toThrow();
  const page = await http(origin, "/");
  expect(page.status).toBe(200);
  expect(page.text).toContain("Private control");
  expect(page.headers["content-security-policy"]).toContain("worker-src 'none'");
  expect(page.headers["cache-control"]).toBe("no-store");
  expect((await http(origin, "/", undefined, { headers: { host: "attacker.example" } })).status).toBe(403);
  expect((await http(origin, "/api/pairing/begin", {}, { headers: { origin: "https://attacker.example" } })).status).toBe(403);
  expect((await http(origin, "/api/pairing/begin", {}, { omitOrigin: true })).status).toBe(403);
  expect((await http(origin, "/secret.json")).status).toBe(404);
  expect((await http(origin, "/key.pem")).status).toBe(404);
  expect((await http(origin, "/api/control/poll")).status).toBe(405);
});

test("one-use short pairing code and key proof cannot bypass local confirmation", async () => {
  const value = host();
  const origin = await enable(value);
  const pending = await begin(value, origin);
  expect(value.snapshot().devices).toHaveLength(0);
  expect(value.snapshot().pendingPairings).toHaveLength(0);
  expect((await http(origin, "/api/pairing/begin", {
    pairingCode: pending.invitation.code, deviceId: pending.identity.deviceId, publicKey: pending.identity.publicKey,
  })).status).toBe(410);
  const proof = createPairingProof(pending.challenge, pending.identity.privateKey);
  const identifiers = { pairingId: pending.pairingId, pairingToken: pending.pairingToken };
  expect((await http(origin, "/api/pairing/prove", { ...identifiers, proof })).status).toBe(200);
  expect(value.snapshot().pendingPairings[0]).toMatchObject({ deviceId: pending.identity.deviceId, label: "Test phone" });
  expect((await http(origin, "/api/pairing/poll", identifiers)).body).toEqual({ status: "pending_confirmation" });
  expect((await http(origin, "/api/pairing/poll", { ...identifiers, pairingToken: "wrong" })).status).toBe(403);
  value.approvePairing(pending.pairingId);
  const grantResponse = await http(origin, "/api/pairing/poll", identifiers);
  const grant = (grantResponse.body as { grant: PairingGrant }).grant;
  expect(grant.deviceId).toBe(pending.identity.deviceId);
  expect(grant.capabilities).toEqual(["sessions.read", "sessions.send", "sessions.stop"]);
  expect(value.snapshot().devices).toHaveLength(1);
  expect(JSON.stringify(value.snapshot())).not.toContain(grant.credential);
  expect(JSON.stringify(value.snapshot())).not.toContain(grant.channel.key);
  expect((await http(origin, "/api/pairing/poll", identifiers)).status).toBe(403);
});

test("rejection, expiry and wrong-code budget fail closed", async () => {
  let now = Date.now();
  const value = host(undefined, () => now);
  const origin = await enable(value);
  const pending = await begin(value, origin);
  await http(origin, "/api/pairing/prove", {
    pairingId: pending.pairingId, pairingToken: pending.pairingToken,
    proof: createPairingProof(pending.challenge, pending.identity.privateKey),
  });
  value.rejectPairing(pending.pairingId);
  expect((await http(origin, "/api/pairing/poll", { pairingId: pending.pairingId, pairingToken: pending.pairingToken })).body)
    .toMatchObject({ error: { code: "pairing_rejected" } });
  expect(() => value.approvePairing(pending.pairingId)).toThrow();
  const invitation = value.createPairing();
  const identity = generateDeviceIdentity();
  for (let i = 0; i < 5; i += 1) expect((await http(origin, "/api/pairing/begin", {
    pairingCode: "incorrect", deviceId: identity.deviceId, publicKey: identity.publicKey,
  })).status).toBe(403);
  expect((await http(origin, "/api/pairing/begin", { pairingCode: invitation.code, deviceId: identity.deviceId, publicKey: identity.publicKey })).status).toBe(410);
  const expired = value.createPairing();
  now += 120_001;
  expect((await http(origin, "/api/pairing/begin", { pairingCode: expired.code, deviceId: identity.deviceId, publicKey: identity.publicKey })).status).toBe(410);
  expect(value.snapshot().pendingPairings).toHaveLength(0);
});

test("real HTTPS encrypted ACK/results preserve at-most-once execution after lost delivery", async () => {
  const operations: string[] = [];
  const value = host({ invoke: (request) => { operations.push(request.operation); return { accepted: true }; } });
  const origin = await enable(value);
  const grant = await pair(value, origin);
  const payload = { sessionId: "existing_task", text: "queued exactly once", mode: "queue" };
  expect((await send(origin, grant, 1, "session.send", payload)).status).toBe(202);
  const lost = await untilFrames(origin, grant, 2);
  expect(lost.map((frame) => frame.type)).toEqual(["ack", "result"]);
  // Device lost both ACK and result. A freshly sealed retransmission keeps the original sequence/request id.
  expect((await send(origin, grant, 1, "session.send", payload)).status).toBe(202);
  const recovery = await untilFrames(origin, grant, 1);
  expect(recovery[0]).toMatchObject({ type: "resync", acknowledgedSequence: 1, expectedSequence: 2 });
  expect(operations).toEqual(["session.send"]);
  expect((await send(origin, grant, 2, "session.snapshot", { sessionId: "existing_task" })).status).toBe(202);
  expect((await untilFrames(origin, grant, 2)).map((frame) => frame.type)).toEqual(["ack", "result"]);
});

test("transport send returns without waiting for a slow service read", async () => {
  let finish: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => { finish = resolve; });
  const value = host({ invoke: async () => { await wait; return { snapshot: true }; } });
  const origin = await enable(value);
  const grant = await pair(value, origin);
  const response = await Promise.race([
    send(origin, grant, 1, "session.snapshot", { sessionId: "existing_task" }),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("HTTP send blocked on service")), 1_000)),
  ]);
  expect(response.status).toBe(202);
  const ack = await untilFrames(origin, grant, 1);
  expect(ack[0]?.type).toBe("ack");
  finish!();
  expect((await untilFrames(origin, grant, 1))[0]?.type).toBe("result");
});

test("device revocation clears unread results; disable/re-enable invalidates old grants", async () => {
  const value = host();
  const origin = await enable(value);
  const grant = await pair(value, origin);
  await send(origin, grant, 1, "sessions.list", {});
  value.revokeDevice(grant.deviceId);
  expect(value.snapshot().devices).toHaveLength(0);
  expect((await http(origin, "/api/control/poll", target(grant), { headers: auth(grant) })).status).toBe(401);
  const nextGrant = await pair(value, origin);
  await value.disable();
  expect(value.snapshot().enabled).toBe(false);
  await expect(http(origin, "/")).rejects.toThrow();
  const nextOrigin = await enable(value);
  expect((await http(nextOrigin, "/api/control/poll", target(nextGrant), { headers: auth(nextGrant) })).status).toBe(401);
});

test("disable during asynchronous HTTPS setup cannot enable a listener later", async () => {
  const value = host();
  const opening = enable(value);
  await value.disable();
  await expect(opening).rejects.toThrow("disabled");
  expect(value.snapshot().enabled).toBe(false);
});

test("API rejects oversized bodies, extra authority fields and missing authentication", async () => {
  const value = host();
  const origin = await enable(value);
  expect((await http(origin, "/api/control/send", { data: "x".repeat(100_001) })).status).toBe(413);
  expect((await http(origin, "/api/pairing/begin", { pairingCode: "fake", capabilities: ["admin"] })).status).toBe(400);
  expect((await http(origin, "/api/control/poll", { deviceId: "unknown", routeId: "unknown" })).status).toBe(401);
  expect((await http(origin, "/api/control/poll", {}, { headers: { "content-type": "text/plain" } })).status).toBe(415);
});

test("a slow read does not block same-device Stop; revocation aborts only its route", async () => {
  let finishRead!: () => void;
  let readEntered!: () => void;
  let readSignal: AbortSignal | undefined;
  const readGate = new Promise<void>((resolve) => { finishRead = resolve; });
  const entered = new Promise<void>((resolve) => { readEntered = resolve; });
  const operations: string[] = [];
  const value = host({ invoke: async (request, context) => {
    if (request.operation === "session.snapshot") {
      readSignal = context.signal;
      readEntered();
      await readGate;
      if (context.signal?.aborted) throw new Error("Revoked request lease");
    }
    operations.push(request.operation);
    return { accepted: true };
  } });
  const origin = await enable(value);
  const first = await pair(value, origin);
  const second = await pair(value, origin);
  try {
    expect((await send(origin, first, 1, "session.snapshot", { sessionId: "existing_task" })).status).toBe(202);
    await entered;
    expect((await send(origin, first, 2, "session.stop", { sessionId: "existing_task" })).status).toBe(202);
    const frames = await untilFrames(origin, first, 3);
    expect(frames.some((frame) => frame.type === "result" && frame.sequence === 2)).toBe(true);
    expect(operations).toEqual(["session.stop"]);
    expect(readSignal?.aborted).toBe(false);
    value.revokeDevice(first.deviceId);
    expect(readSignal?.aborted).toBe(true);
    expect(value.snapshot().devices.map((device) => device.deviceId)).toEqual([second.deviceId]);
    finishRead();
    expect((await http(origin, "/api/control/poll", target(first), { headers: auth(first) })).status).toBe(401);
    expect((await send(origin, second, 1, "session.send", { sessionId: "existing_task", text: "Still authorized", mode: "queue" })).status).toBe(202);
    expect((await untilFrames(origin, second, 2)).map((frame) => frame.type)).toEqual(["ack", "result"]);
    expect(operations).toEqual(["session.stop", "session.send"]);
  } finally { finishRead(); }
});

test("outbound poll accounts for complete serialized encrypted envelopes", async () => {
  let executions = 0;
  const value = host({ invoke: () => { executions += 1; return { content: "界".repeat(12_000) }; } });
  const origin = await enable(value);
  const grant = await pair(value, origin);
  for (let sequence = 1; sequence <= 32; sequence += 1) {
    expect((await send(origin, grant, sequence, "session.snapshot", { sessionId: "existing_task" })).status).toBe(202);
  }
  const response = await http(origin, "/api/control/poll", target(grant), { headers: auth(grant) });
  expect(response.status).toBe(200);
  expect(Buffer.byteLength(response.text)).toBeLessThanOrEqual(1_048_576);
  expect((response.body as { envelopes: unknown[] }).envelopes.length).toBeLessThanOrEqual(64);
  expect(executions).toBe(32);
  // A full result queue does not roll admission back or make a repeated prompt safe to execute twice.
  expect((await send(origin, grant, 32, "session.snapshot", { sessionId: "existing_task" })).status).toBe(202);
  expect((await untilFrames(origin, grant, 1))[0]).toMatchObject({ type: "resync", acknowledgedSequence: 32 });
  expect(executions).toBe(32);
});
