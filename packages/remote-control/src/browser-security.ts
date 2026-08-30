import { decodeBase64Url, encodeBase64Url } from "./http-wire.js";
import { pairingProofBytes, relayAadBytes, relayKeyDerivationBytes } from "./security-transcripts.js";
import {
  REMOTE_CONTROL_CAPABILITIES,
  REMOTE_CONTROL_LIMITS,
  parseOpaqueRelayEnvelope,
  parseRemoteControlHostId,
  type OpaqueRelayEnvelope,
  type RemoteControlRelayDirection,
} from "./protocol.js";
import type { PairingChallenge, PairingGrant, PairingProof, RelayChannelKey } from "./pairing-security.js";

export class BrowserSecurityError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BrowserSecurityError";
  }
}

export interface BrowserDeviceIdentity {
  readonly algorithm: "Ed25519";
  readonly deviceId: string;
  readonly publicKey: string;
  /** Nonextractable, memory-only. No secret is persisted independently of replay state. */
  readonly privateKey: CryptoKey;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function requireSecureBrowserCrypto(): Crypto {
  // A browser on HTTP (including localhost) must never silently use a weaker path.
  if (typeof location !== "undefined" && (location.protocol !== "https:" || !globalThis.isSecureContext)) {
    throw new BrowserSecurityError("TRUSTED_HTTPS_REQUIRED");
  }
  if (!globalThis.crypto?.subtle || !globalThis.crypto.getRandomValues) {
    throw new BrowserSecurityError("WEB_CRYPTO_UNSUPPORTED");
  }
  return globalThis.crypto;
}

export function browserRandomIdentifier(prefix: string): string {
  const bytes = requireSecureBrowserCrypto().getRandomValues(new Uint8Array(16));
  return `${prefix}_${encodeBase64Url(bytes)}`;
}

export async function generateBrowserDeviceIdentity(): Promise<BrowserDeviceIdentity> {
  const crypto = requireSecureBrowserCrypto();
  try {
    const keys = await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"]);
    const pair = keys as CryptoKeyPair;
    const publicKeyBytes = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", publicKeyBytes));
    // Probe the complete required suite now, before consuming a one-time pairing code.
    const probe = { hostId: "browser_probe", routeId: "route_probe", key: encodeBase64Url(crypto.getRandomValues(new Uint8Array(32))) };
    await directionalKey(probe, "device_to_host");
    return Object.freeze({
      algorithm: "Ed25519",
      deviceId: `device_${encodeBase64Url(digest)}`,
      publicKey: encodeBase64Url(publicKeyBytes),
      privateKey: pair.privateKey,
    });
  } catch {
    throw new BrowserSecurityError("BROWSER_CRYPTO_UNSUPPORTED");
  }
}

export function validateBrowserPairingChallenge(value: unknown, identity: BrowserDeviceIdentity): PairingChallenge {
  const challenge = value as PairingChallenge | null;
  if (!challenge || challenge.version !== 1 || challenge.deviceId !== identity.deviceId
    || challenge.publicKey !== identity.publicKey || !/^pair_[A-Za-z0-9_-]{43}$/.test(challenge.nonce)
    || !/^route_[A-Za-z0-9_-]{24}$/.test(challenge.routeId)
    || !Array.isArray(challenge.capabilities) || challenge.capabilities.length === 0
    || new Set(challenge.capabilities).size !== challenge.capabilities.length
    || challenge.capabilities.some((capability) => !REMOTE_CONTROL_CAPABILITIES.includes(capability))
    || !Number.isSafeInteger(challenge.issuedAt) || !Number.isSafeInteger(challenge.expiresAt)
    || challenge.issuedAt < 0 || challenge.expiresAt <= challenge.issuedAt
    || Date.now() >= challenge.expiresAt) {
    throw new BrowserSecurityError("PAIRING_CHALLENGE_INVALID");
  }
  parseRemoteControlHostId(challenge.hostId);
  return challenge;
}

export async function createBrowserPairingProof(challenge: PairingChallenge, identity: BrowserDeviceIdentity): Promise<PairingProof> {
  validateBrowserPairingChallenge(challenge, identity);
  const signature = await requireSecureBrowserCrypto().subtle.sign("Ed25519", identity.privateKey, pairingProofBytes(challenge));
  return { version: 1, nonce: challenge.nonce, signature: encodeBase64Url(new Uint8Array(signature)) };
}

export function validateBrowserPairingGrant(value: unknown, challenge: PairingChallenge): PairingGrant {
  const grant = value as PairingGrant | null;
  if (!grant || grant.hostId !== challenge.hostId || grant.deviceId !== challenge.deviceId
    || grant.channel?.hostId !== challenge.hostId || grant.channel?.routeId !== challenge.routeId
    || !Array.isArray(grant.capabilities) || JSON.stringify(grant.capabilities) !== JSON.stringify(challenge.capabilities)
    || typeof grant.credential !== "string" || !/^chili_rc1_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}$/.test(grant.credential)
    || !Number.isSafeInteger(grant.issuedAt) || !Number.isSafeInteger(grant.expiresAt)
    || grant.issuedAt < 0 || grant.expiresAt <= grant.issuedAt || Date.now() >= grant.expiresAt) {
    throw new BrowserSecurityError("PAIRING_GRANT_INVALID");
  }
  if (decodeBase64Url(grant.channel.key, 32).byteLength !== 32) throw new BrowserSecurityError("PAIRING_GRANT_INVALID");
  return Object.freeze({ ...grant, channel: Object.freeze({ ...grant.channel }), capabilities: Object.freeze([...grant.capabilities]) });
}

/** No eviction: exhaustion requires reconnect with the complete stream state retained. */
export class BrowserReplayGuard {
  readonly #seen = new Set<string>();
  constructor(readonly maxEntries = 4_096) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) throw new BrowserSecurityError("RELAY_REPLAY_WINDOW_EXHAUSTED");
  }
  get size(): number { return this.#seen.size; }
  has(envelope: OpaqueRelayEnvelope): boolean { return this.#seen.has(this.#key(envelope)); }
  record(envelope: OpaqueRelayEnvelope): void {
    if (this.has(envelope)) throw new BrowserSecurityError("RELAY_REPLAYED");
    if (this.size >= this.maxEntries) throw new BrowserSecurityError("RELAY_REPLAY_WINDOW_EXHAUSTED");
    this.#seen.add(this.#key(envelope));
  }
  #key(envelope: OpaqueRelayEnvelope): string { return `${envelope.routeId}\u0000${envelope.direction}\u0000${envelope.messageId}`; }
}

export async function sealBrowserRelayEnvelope(
  channel: RelayChannelKey,
  direction: RemoteControlRelayDirection,
  inner: unknown,
): Promise<OpaqueRelayEnvelope> {
  const crypto = requireSecureBrowserCrypto();
  const serialized = JSON.stringify(inner);
  if (serialized === undefined) throw new BrowserSecurityError("RELAY_ENVELOPE_INVALID");
  const plaintext = encoder.encode(serialized);
  if (plaintext.byteLength > REMOTE_CONTROL_LIMITS.maxFrameBytes) throw new BrowserSecurityError("MESSAGE_TOO_LARGE");
  const metadata = {
    version: 1 as const,
    routeId: channel.routeId,
    direction,
    messageId: browserRandomIdentifier("message"),
    byteLength: plaintext.byteLength + 28,
    createdAt: Date.now(),
  };
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: relayAadBytes(channel, metadata), tagLength: 128 }, await directionalKey(channel, direction), plaintext);
  const ciphertext = new Uint8Array(metadata.byteLength);
  ciphertext.set(nonce);
  ciphertext.set(new Uint8Array(encrypted), nonce.byteLength);
  return parseOpaqueRelayEnvelope({ ...metadata, ciphertext });
}

export async function openBrowserRelayEnvelope(
  channel: RelayChannelKey,
  value: unknown,
  replayGuard: BrowserReplayGuard,
): Promise<unknown> {
  const envelope = parseOpaqueRelayEnvelope(value);
  if (envelope.direction !== "host_to_device" || envelope.routeId !== channel.routeId || envelope.byteLength < 28) {
    throw new BrowserSecurityError("RELAY_ENVELOPE_INVALID");
  }
  if (replayGuard.has(envelope)) throw new BrowserSecurityError("RELAY_REPLAYED");
  let plaintext: ArrayBuffer;
  try {
    plaintext = await requireSecureBrowserCrypto().subtle.decrypt({
      name: "AES-GCM",
      iv: new Uint8Array(envelope.ciphertext.slice(0, 12)),
      additionalData: relayAadBytes(channel, envelope),
      tagLength: 128,
    }, await directionalKey(channel, envelope.direction), new Uint8Array(envelope.ciphertext.slice(12)));
  } catch {
    throw new BrowserSecurityError("RELAY_DECRYPTION_FAILED");
  }
  let inner: unknown;
  try { inner = JSON.parse(decoder.decode(plaintext)); }
  catch { throw new BrowserSecurityError("RELAY_ENVELOPE_INVALID"); }
  replayGuard.record(envelope);
  return inner;
}

async function directionalKey(channel: RelayChannelKey, direction: RemoteControlRelayDirection): Promise<CryptoKey> {
  parseRemoteControlHostId(channel.hostId);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(channel.routeId)
    || (direction !== "device_to_host" && direction !== "host_to_device")) {
    throw new BrowserSecurityError("RELAY_ENVELOPE_INVALID");
  }
  const rootBytes = decodeBase64Url(channel.key, 32);
  if (rootBytes.byteLength !== 32) throw new BrowserSecurityError("RELAY_ENVELOPE_INVALID");
  const crypto = requireSecureBrowserCrypto();
  const root = await crypto.subtle.importKey("raw", rootBytes, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", ...relayKeyDerivationBytes(channel, direction) }, root,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
