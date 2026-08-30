import { expect, test } from "bun:test";
import {
  BrowserReplayGuard,
  createBrowserPairingProof,
  generateBrowserDeviceIdentity,
  openBrowserRelayEnvelope,
  sealBrowserRelayEnvelope,
  validateBrowserPairingGrant,
} from "./browser-security.js";
import { BrowserControlClient } from "./browser-client.js";
import { decodeWireEnvelope, encodeWireEnvelope } from "./http-wire.js";
import {
  InMemoryPairingAuthority,
  deriveDeviceId,
  openRelayEnvelope,
  sealRelayEnvelope,
} from "./pairing-security.js";
import { parseOpaqueRelayEnvelope } from "./protocol.js";

test("browser nonextractable Ed25519 identity/proof interoperates with Node pairing authority", async () => {
  const identity = await generateBrowserDeviceIdentity();
  expect(identity.privateKey.extractable).toBe(false);
  expect(deriveDeviceId(identity.publicKey)).toBe(identity.deviceId);
  const authority = new InMemoryPairingAuthority({ hostId: "browser_interop", allowedCapabilities: ["sessions.read", "sessions.send", "sessions.stop"] });
  const challenge = authority.beginPairing({ ...identity, grantedCapabilities: ["sessions.read", "sessions.send"] });
  const proof = await createBrowserPairingProof(challenge, identity);
  const grant = validateBrowserPairingGrant(authority.completePairing(proof), challenge);
  expect(grant.deviceId).toBe(identity.deviceId);
  expect(() => authority.completePairing(proof)).toThrow("PAIRING_NONCE_REUSED");
  const secondChallenge = authority.beginPairing({ ...identity, grantedCapabilities: ["sessions.read"] });
  const tamperedProof = await createBrowserPairingProof({ ...secondChallenge, hostId: "other_host" }, identity);
  expect(() => authority.completePairing(tamperedProof)).toThrow("PAIRING_PROOF_INVALID");
});

test("browser AES-GCM/HKDF/AAD and JSON wire interoperate with Node in both directions", async () => {
  const { channel } = await paired();
  const frame = { secret: "pairing credential stays encrypted", prompt: "中文控制 🔒" };
  const sealed = await sealBrowserRelayEnvelope(channel, "device_to_host", frame);
  const wire = encodeWireEnvelope(sealed);
  expect(JSON.stringify(wire)).not.toContain(frame.secret);
  expect(JSON.stringify(wire)).not.toContain(frame.prompt);
  expect(openRelayEnvelope<unknown>(channel, decodeWireEnvelope(wire), { expectedDirection: "device_to_host" })).toEqual(frame);
  const hostEnvelope = sealRelayEnvelope(channel, "host_to_device", frame);
  expect(await openBrowserRelayEnvelope(channel, decodeWireEnvelope(encodeWireEnvelope(parseOpaqueRelayEnvelope(hostEnvelope))), new BrowserReplayGuard())).toEqual(frame);
});

test("browser fails closed on replay, direction/AAD tampering, oversized wire and exhausted replay memory", async () => {
  const { channel } = await paired();
  const hostEnvelope = sealRelayEnvelope(channel, "host_to_device", { valid: true });
  const replay = new BrowserReplayGuard(1);
  await openBrowserRelayEnvelope(channel, hostEnvelope, replay);
  await expect(openBrowserRelayEnvelope(channel, hostEnvelope, replay)).rejects.toThrow("RELAY_REPLAYED");
  await expect(openBrowserRelayEnvelope(channel, { ...hostEnvelope, createdAt: hostEnvelope.createdAt + 1 }, new BrowserReplayGuard())).rejects.toThrow("RELAY_DECRYPTION_FAILED");
  await expect(openBrowserRelayEnvelope(channel, { ...hostEnvelope, direction: "device_to_host" }, new BrowserReplayGuard())).rejects.toThrow("RELAY_ENVELOPE_INVALID");
  const changedHost = { ...channel, hostId: "wrong_host" };
  await expect(openBrowserRelayEnvelope(changedHost, hostEnvelope, new BrowserReplayGuard())).rejects.toThrow("RELAY_DECRYPTION_FAILED");
  await expect(openBrowserRelayEnvelope(channel, sealRelayEnvelope(channel, "host_to_device", { valid: true }), replay)).rejects.toThrow("RELAY_REPLAY_WINDOW_EXHAUSTED");
  expect(() => decodeWireEnvelope({ ...encodeWireEnvelope(parseOpaqueRelayEnvelope(hostEnvelope)), ciphertext: "A".repeat(100_000) })).toThrow("INVALID_BASE64URL");
});

test("browser refuses plaintext endpoints before issuing a request", async () => {
  const grant = await paired();
  expect(() => new BrowserControlClient({ baseUrl: "http://127.0.0.1:8844", pairing: grant })).toThrow("TRUSTED_HTTPS_REQUIRED");
});

test("unsupported browser crypto and insecure browser contexts fail explicitly without a fallback", async () => {
  const moduleUrl = new URL("./browser-security.ts", import.meta.url).href;
  for (const [setup, expected] of [
    ["Object.defineProperty(globalThis, 'crypto', { value: undefined });", "WEB_CRYPTO_UNSUPPORTED"],
    ["Object.defineProperty(globalThis, 'crypto', { value: { subtle: { generateKey: async () => { throw new Error('unsupported'); } }, getRandomValues() {} } });", "BROWSER_CRYPTO_UNSUPPORTED"],
    ["globalThis.location = { protocol: 'http:' }; globalThis.isSecureContext = false;", "TRUSTED_HTTPS_REQUIRED"],
  ] as const) {
    const child = Bun.spawn([process.execPath, "-e", `const {generateBrowserDeviceIdentity}=await import(${JSON.stringify(moduleUrl)}); ${setup} try { await generateBrowserDeviceIdentity(); process.exit(2); } catch(error) { console.log(error.code); }`], { stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.trim()).toBe(expected);
  }
});

test("browser entry bundles without Node crypto or fake endpoints", async () => {
  const build = await Bun.build({ entrypoints: [new URL("./browser.ts", import.meta.url).pathname], target: "browser" });
  expect(build.success).toBe(true);
  const source = await build.outputs[0]!.text();
  expect(source).not.toContain("node:crypto");
  expect(source).not.toContain("FakeMobileClient");
  expect(source).not.toContain("MockControlService");
  expect(source).not.toContain("localStorage");
  expect(source).not.toContain("sessionStorage");
});

async function paired() {
  const identity = await generateBrowserDeviceIdentity();
  const authority = new InMemoryPairingAuthority({ hostId: "browser_interop", allowedCapabilities: ["sessions.read", "sessions.send", "sessions.stop"] });
  const challenge = authority.beginPairing({ ...identity, grantedCapabilities: ["sessions.read", "sessions.send", "sessions.stop"] });
  return authority.completePairing(await createBrowserPairingProof(challenge, identity));
}
