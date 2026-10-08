import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PrivateControlHttpsHost } from "./https-host.js";
import {
  createPairingProof,
  generateDeviceIdentity,
  type PairingChallenge,
  type PairingGrant,
} from "./pairing-security.js";

// Independent protocol-level review: exercise a real TLS listener with separate
// devices instead of bypassing its authentication and lifecycle boundaries.
let directory: string;
let certificate: Buffer;
let certPath: string;
let keyPath: string;
const hosts: PrivateControlHttpsHost[] = [];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "chili-mobile-security-review-"));
  certPath = join(directory, "certificate.pem");
  keyPath = join(directory, "key.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath,
    "-out", certPath, "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ], { stdio: "ignore" });
  certificate = await readFile(certPath);
  await writeFile(join(directory, "index.html"), "<!doctype html><title>Mobile review fixture</title>");
});

afterEach(async () => { await Promise.all(hosts.splice(0).map((host) => host.disable())); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

type Identity = ReturnType<typeof generateDeviceIdentity>;
interface ChallengeHandle {
  pairingId: string;
  pairingToken: string;
  challenge: PairingChallenge;
  expiresAt: number;
}
interface GrantResponse { status: string; grant: PairingGrant }
interface HttpResult { status: number; body: unknown }

async function enable(host: PrivateControlHttpsHost): Promise<string> {
  return (await host.enable({
    bindAddress: "127.0.0.1", port: 0, publicOrigin: "https://127.0.0.1:0",
    tlsCertPath: certPath, tlsKeyPath: keyPath, webRoot: directory,
  })).origin!;
}

async function fixture() {
  const host = new PrivateControlHttpsHost({ controlService: { invoke: () => ({ sessions: [] }) } });
  hosts.push(host);
  return { host, origin: await enable(host) };
}

function post(origin: string, path: string, body: unknown, credential?: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const request = httpsRequest(new URL(path, origin), {
      ca: certificate,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(data)),
        origin,
        ...(credential ? { authorization: `Bearer ${credential}` } : {}),
      },
      servername: "localhost",
      agent: false,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        try { resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
        catch (error) { reject(error); }
      });
      response.once("error", reject);
    });
    request.once("error", reject);
    request.end(data);
  });
}

async function pair(host: PrivateControlHttpsHost, origin: string) {
  const identity = generateDeviceIdentity();
  const invitation = host.createPairing();
  const begin = await post(origin, "/api/pairing/begin", {
    pairingCode: invitation.code, deviceId: identity.deviceId,
    publicKey: identity.publicKey, label: "Review phone", rememberDevice: true,
  });
  expect(begin.status).toBe(200);
  const handle = begin.body as ChallengeHandle;
  expect((await post(origin, "/api/pairing/prove", proofBody(handle, identity))).status).toBe(200);
  host.approvePairing(handle.pairingId);
  const approved = await post(origin, "/api/pairing/poll", handleBody(handle));
  expect(approved.status).toBe(200);
  return { identity, grant: (approved.body as GrantResponse).grant };
}

function handleBody(handle: ChallengeHandle) {
  return { pairingId: handle.pairingId, pairingToken: handle.pairingToken };
}

function proofBody(handle: ChallengeHandle, identity: Identity) {
  return { ...handleBody(handle), proof: createPairingProof(handle.challenge, identity.privateKey) };
}

async function beginRecovery(origin: string, grant: PairingGrant, identity: Identity) {
  const response = await post(origin, "/api/recovery/begin", {
    hostId: grant.hostId, deviceId: identity.deviceId, publicKey: identity.publicKey,
  });
  expect(response.status).toBe(200);
  return response.body as ChallengeHandle;
}

function poll(origin: string, grant: PairingGrant) {
  return post(origin, "/api/control/poll", {
    deviceId: grant.deviceId, routeId: grant.channel.routeId,
  }, grant.credential);
}

test("a completed recovery invalidates competing challenges before they can rotate its new route", async () => {
  const { host, origin } = await fixture();
  const { identity, grant } = await pair(host, origin);
  const first = await beginRecovery(origin, grant, identity);
  const second = await beginRecovery(origin, grant, identity);
  expect((await poll(origin, grant)).status).toBe(200);

  const recovered = await post(origin, "/api/recovery/prove", proofBody(first, identity));
  expect(recovered.status).toBe(200);
  const next = (recovered.body as GrantResponse).grant;
  expect((await poll(origin, grant)).status).toBeGreaterThanOrEqual(400);
  expect((await post(origin, "/api/recovery/prove", proofBody(second, identity))).status).toBeGreaterThanOrEqual(400);
  expect((await poll(origin, next)).status).toBe(200);
  expect(host.snapshot().devices.map((device) => device.deviceId)).toEqual([identity.deviceId]);
});

test("simultaneous recovery proofs publish only one channel and a lost response remains recoverable", async () => {
  const { host, origin } = await fixture();
  const { identity, grant } = await pair(host, origin);
  const first = await beginRecovery(origin, grant, identity);
  const second = await beginRecovery(origin, grant, identity);
  const results = await Promise.all([
    post(origin, "/api/recovery/prove", proofBody(first, identity)),
    post(origin, "/api/recovery/prove", proofBody(second, identity)),
  ]);
  expect(results.filter((result) => result.status === 200)).toHaveLength(1);
  expect(results.filter((result) => result.status >= 400)).toHaveLength(1);
  const firstGrant = (results.find((result) => result.status === 200)!.body as GrantResponse).grant;

  // A phone killed before receiving that response still only has its original
  // identity and host locator. It needs neither the discarded grant nor its key.
  const retry = await beginRecovery(origin, grant, identity);
  const recovered = await post(origin, "/api/recovery/prove", proofBody(retry, identity));
  expect(recovered.status).toBe(200);
  expect((await poll(origin, firstGrant)).status).toBeGreaterThanOrEqual(400);
  expect((await poll(origin, (recovered.body as GrantResponse).grant)).status).toBe(200);
  expect(host.snapshot().devices).toHaveLength(1);
});

test("two devices cannot exchange recovery handles or proofs and recovering one leaves the other authorized", async () => {
  const { host, origin } = await fixture();
  const a = await pair(host, origin);
  const b = await pair(host, origin);
  const handleA = await beginRecovery(origin, a.grant, a.identity);
  const handleB = await beginRecovery(origin, b.grant, b.identity);

  const swappedToken = await post(origin, "/api/recovery/prove", {
    pairingId: handleA.pairingId, pairingToken: handleB.pairingToken,
    proof: createPairingProof(handleA.challenge, a.identity.privateKey),
  });
  expect(swappedToken.status).toBeGreaterThanOrEqual(400);
  expect((await post(origin, "/api/recovery/prove", proofBody(handleA, b.identity))).status).toBeGreaterThanOrEqual(400);
  expect((await poll(origin, a.grant)).status).toBe(200);
  expect((await poll(origin, b.grant)).status).toBe(200);

  const freshA = await beginRecovery(origin, a.grant, a.identity);
  expect((await post(origin, "/api/recovery/prove", proofBody(freshA, a.identity))).status).toBe(200);
  // Recovery only invalidates pending challenges belonging to the same device.
  const recoveredB = await post(origin, "/api/recovery/prove", proofBody(handleB, b.identity));
  expect(recoveredB.status).toBe(200);
  expect((await poll(origin, (recoveredB.body as GrantResponse).grant)).status).toBe(200);
});

test("device revocation while a valid proof is being prepared prevents recovery without affecting other devices", async () => {
  const { host, origin } = await fixture();
  const a = await pair(host, origin);
  const b = await pair(host, origin);
  const handle = await beginRecovery(origin, a.grant, a.identity);
  const body = proofBody(handle, a.identity);
  host.revokeDevice(a.identity.deviceId);

  expect((await post(origin, "/api/recovery/prove", body)).status).toBeGreaterThanOrEqual(400);
  expect((await poll(origin, a.grant)).status).toBeGreaterThanOrEqual(400);
  expect((await poll(origin, b.grant)).status).toBe(200);
  expect(host.snapshot().devices.map((device) => device.deviceId)).toEqual([b.identity.deviceId]);
});

test("a host epoch change rejects a previously prepared valid proof and the remembered identity", async () => {
  const { host, origin } = await fixture();
  const { grant, identity } = await pair(host, origin);
  const pending = await beginRecovery(origin, grant, identity);
  const proof = proofBody(pending, identity);
  await host.disable();
  const newOrigin = await enable(host);

  expect((await post(newOrigin, "/api/recovery/prove", proof)).status).toBeGreaterThanOrEqual(400);
  expect((await post(newOrigin, "/api/recovery/begin", {
    hostId: grant.hostId, deviceId: identity.deviceId, publicKey: identity.publicKey,
  })).status).toBeGreaterThanOrEqual(400);
  expect((await poll(newOrigin, grant)).status).toBeGreaterThanOrEqual(400);
  expect(host.snapshot().devices).toHaveLength(0);
});
