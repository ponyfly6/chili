import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserControlClient } from "./browser-client.js";
import { createNativeControlPlatform, type NativeControlHttpRequest, type NativeControlHttpResponse } from "./client-platform.js";
import { createRecoverableDeviceIdentity, parseDeviceRecoveryRecord, restoreDeviceIdentity, validateDeviceRecoveryMetadata, type DeviceRecoveryRecord } from "./device-recovery.js";
import { PrivateControlHttpsHost } from "./https-host.js";
import type { PairingGrant } from "./pairing-security.js";

let directory: string;
let cert: Buffer;
const hosts: PrivateControlHttpsHost[] = [];
const clients: BrowserControlClient[] = [];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "chili-native-client-test-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
    "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem")], { stdio: "ignore" });
  cert = await readFile(join(directory, "cert.pem"));
  await writeFile(join(directory, "index.html"), "<!doctype html><title>Native client test</title>");
});
afterEach(async () => {
  for (const client of clients.splice(0)) client.dispose();
  await Promise.all(hosts.splice(0).map((host) => host.disable()));
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

function nativeHttps(input: NativeControlHttpRequest): Promise<NativeControlHttpResponse> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(input.url, { method: "POST", ca: cert, rejectUnauthorized: true,
      agent: false, headers: input.headers, signal: input.signal }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > input.maxResponseBytes) { response.destroy(); reject(new Error("RESPONSE_TOO_LARGE")); return; }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.once("error", reject);
    request.end(input.body);
  });
}

async function setup(failStorage = false, hostClockOffsetMs = 0) {
  const executed: string[] = [];
  const grants: PairingGrant[] = [];
  const paths: string[] = [];
  let record: DeviceRecoveryRecord | undefined;
  let loseSendResponse = false;
  const host = new PrivateControlHttpsHost({
    now: () => Date.now() + hostClockOffsetMs,
    controlService: { invoke(request) { executed.push(request.operation); return { ok: true }; } },
    onStateChange(state) { for (const pending of state.pendingPairings) host.approvePairing(pending.pairingId); },
  });
  hosts.push(host);
  const state = await host.enable({ bindAddress: "127.0.0.1", port: 0, publicOrigin: "https://127.0.0.1:0",
    tlsCertPath: join(directory, "cert.pem"), tlsKeyPath: join(directory, "key.pem"), webRoot: directory });
  const baseUrl = state.origin!;
  const platform = createNativeControlPlatform({ baseUrl, crypto: globalThis.crypto, async postJson(input) {
    const path = new URL(input.url).pathname;
    paths.push(path);
    expect(input.headers["X-Chili-Control-Client"]).toBe("native-v1");
    expect(Object.keys(input.headers).some((key) => /^(origin|sec-fetch-)/i.test(key))).toBe(false);
    const response = await nativeHttps(input);
    const body = JSON.parse(response.body) as { grant?: PairingGrant };
    if (body.grant) grants.push(body.grant);
    if (loseSendResponse && path === "/api/control/send") throw new Error("Simulated transport loss after dispatch");
    return response;
  } });
  const client = await BrowserControlClient.pair({ baseUrl, platform, pairingCode: host.createPairing().code,
    rememberDevice: true, recoveryStore: { async save(value) {
      if (failStorage) throw new Error("Keychain unavailable");
      record = value;
    } } });
  clients.push(client);
  if (!record) throw new Error("Missing recovery record");
  return { host, client, baseUrl, platform, record, grants, paths, executed,
    loseResponse() { loseSendResponse = true; } };
}

test("native client pairs, securely serializes identity, resumes a fresh route and never restores old ciphertext state", async () => {
  const fixture = await setup();
  await fixture.client.request("sessions.list", {});
  const stored = parseDeviceRecoveryRecord(JSON.parse(JSON.stringify(fixture.record)));
  expect(Object.keys(stored).sort()).toEqual(["baseUrl", "deviceId", "expiresAt", "hostId", "privateKeyPkcs8", "publicKey", "version"]);
  const identity = await restoreDeviceIdentity(stored, crypto);
  expect(identity.privateKey.extractable).toBe(false);
  fixture.client.dispose();
  const resumed = await BrowserControlClient.resume({ record: stored, platform: fixture.platform });
  clients.push(resumed);
  expect(fixture.grants).toHaveLength(2);
  expect(fixture.grants[1]!.channel.routeId).not.toBe(fixture.grants[0]!.channel.routeId);
  expect(fixture.grants[1]!.channel.key).not.toBe(fixture.grants[0]!.channel.key);
  expect(fixture.grants[1]!.credential).not.toBe(fixture.grants[0]!.credential);
  await resumed.request("sessions.list", {});
  expect(fixture.executed).toEqual(["sessions.list", "sessions.list"]);
  expect(fixture.host.snapshot().devices).toHaveLength(1);
  fixture.host.revokeDevice(stored.deviceId);
  await expect(BrowserControlClient.resume({ record: stored, platform: fixture.platform })).rejects.toThrow();
});

for (const operation of ["session.send", "session.answerInput"] as const) test(`cold resume does not retry ${operation} whose HTTP result was lost`, async () => {
  const fixture = await setup();
  fixture.loseResponse();
  const result = operation === "session.send"
    ? fixture.client.request(operation, { sessionId: "task_native", text: "do once", mode: "queue" })
    : fixture.client.request(operation, { sessionId: "task_native", inputId: "input_native", answers: { choice: ["one"] } });
  await expect(result).rejects.toThrow("outcome_unknown");
  await Bun.sleep(50);
  expect(fixture.executed).toEqual([operation]);
  fixture.client.dispose();
  const before = fixture.paths.filter((path) => path === "/api/control/send").length;
  const resumed = await BrowserControlClient.resume({ record: fixture.record, platform: fixture.platform });
  clients.push(resumed);
  await Bun.sleep(50);
  expect(fixture.paths.filter((path) => path === "/api/control/send")).toHaveLength(before);
  expect(fixture.executed).toEqual([operation]);
});

test("secure storage failure is distinct from successful pairing and never silently falls back", async () => {
  await expect(setup(true)).rejects.toThrow("RECOVERY_STORAGE_FAILED");
  expect(hosts[0]!.snapshot().devices).toHaveLength(1);
  expect(clients).toHaveLength(0);
});

test("a desktop clock thirty seconds ahead can pair and recover without extending its original trust deadline", async () => {
  const fixture = await setup(false, 30_000);
  expect(fixture.record.expiresAt).toBeGreaterThan(Date.now() + 8 * 60 * 60 * 1_000);
  const originalExpiry = fixture.record.expiresAt;
  fixture.client.dispose();
  const resumed = await BrowserControlClient.resume({ record: fixture.record, platform: fixture.platform });
  clients.push(resumed);
  await resumed.request("sessions.list", {});
  expect(fixture.host.snapshot().devices[0]!.expiresAt).toBe(originalExpiry);
  expect(fixture.grants[1]!.expiresAt).toBeLessThanOrEqual(originalExpiry);
  expect(() => validateDeviceRecoveryMetadata({ ...fixture.record, expiresAt: originalExpiry + 1 }, fixture.record, originalExpiry)).toThrow("RECOVERY_METADATA_INVALID");
  expect(() => validateDeviceRecoveryMetadata({ ...fixture.record, expiresAt: Date.now() - 1 }, fixture.record, originalExpiry)).toThrow("RECOVERY_METADATA_INVALID");
});

test("recovery rejects expired, cross-origin and mismatched private identities before any network request", async () => {
  const fixture = await setup();
  fixture.client.dispose();
  const before = fixture.paths.length;
  await expect(BrowserControlClient.resume({ record: { ...fixture.record, expiresAt: Date.now() - 1 }, platform: fixture.platform })).rejects.toThrow("PAIRING_REQUIRED");
  await expect(BrowserControlClient.resume({ record: { ...fixture.record, baseUrl: "https://other.example" }, platform: fixture.platform })).rejects.toThrow("NATIVE_PLATFORM_ORIGIN_MISMATCH");
  const other = await createRecoverableDeviceIdentity(crypto);
  await expect(BrowserControlClient.resume({ record: { ...fixture.record, privateKeyPkcs8: other.privateKeyPkcs8 }, platform: fixture.platform })).rejects.toThrow("RECOVERY_IDENTITY_INVALID");
  expect(fixture.paths).toHaveLength(before);
});

test("native adapter is explicit and instance-bound; default browser HTTPS/same-origin rules remain intact", async () => {
  const moduleUrl = new URL("./browser.ts", import.meta.url).href;
  const child = Bun.spawn([process.execPath, "-e", `
    const {BrowserControlClient,createNativeControlPlatform,generateBrowserDeviceIdentity}=await import(${JSON.stringify(moduleUrl)});
    globalThis.location={protocol:'capacitor:',origin:'capacitor://localhost'};globalThis.isSecureContext=true;
    let calls=0;
    const platform=createNativeControlPlatform({baseUrl:'https://127.0.0.1:1234',crypto:globalThis.crypto,postJson:async()=>{calls++;return {status:400,body:'{}'}}});
    const grant={hostId:'host_test',deviceId:'device_test',credential:'invalid',capabilities:[],channel:{hostId:'host_test',routeId:'route_test',key:''},issuedAt:0,expiresAt:Date.now()+1000};
    const expected=[];
    try { new BrowserControlClient({baseUrl:platform.baseUrl,pairing:grant}); } catch(e) { expected.push(e.code); }
    try { await generateBrowserDeviceIdentity(); } catch(e) { expected.push(e.code); }
    try { new BrowserControlClient({baseUrl:platform.baseUrl,pairing:grant,platform:{...platform}}); } catch(e) { expected.push(e.message); }
    const client=new BrowserControlClient({baseUrl:platform.baseUrl,pairing:grant,platform});client.dispose();
    console.log(JSON.stringify({expected,calls}));
  `], { stdout: "pipe", stderr: "pipe" });
  const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(status).toBe(0);
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toEqual({ expected: ["SAME_ORIGIN_REQUIRED", "TRUSTED_HTTPS_REQUIRED", "NATIVE_PLATFORM_ORIGIN_MISMATCH"], calls: 0 });
});

test("persistent pairing requires explicit native platform and secure store", async () => {
  await expect(BrowserControlClient.pair({ baseUrl: "https://127.0.0.1", pairingCode: "test", rememberDevice: true })).rejects.toThrow("NATIVE_RECOVERY_STORE_REQUIRED");
  expect(() => createNativeControlPlatform({ baseUrl: "http://127.0.0.1", crypto, postJson: nativeHttps })).toThrow("TRUSTED_HTTPS_REQUIRED");
});
