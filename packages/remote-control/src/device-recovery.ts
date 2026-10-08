import { BrowserSecurityError, sealBrowserRelayEnvelope, type BrowserDeviceIdentity } from "./browser-security.js";
import { canonicalControlOrigin } from "./client-platform.js";
import { decodeBase64Url, encodeBase64Url } from "./http-wire.js";
import { parseRemoteControlHostId } from "./protocol.js";

/** Sensitive: persist the entire record only in the native Keychain/Keystore. */
export interface DeviceRecoveryRecord {
  readonly version: 1;
  readonly baseUrl: string;
  readonly hostId: string;
  readonly deviceId: string;
  readonly publicKey: string;
  readonly privateKeyPkcs8: string;
  readonly expiresAt: number;
}

export interface DeviceRecoveryStore {
  save(record: DeviceRecoveryRecord): Promise<void>;
}

export interface DeviceRecoveryMetadata {
  readonly version: 1;
  readonly hostId: string;
  readonly deviceId: string;
  readonly publicKey: string;
  readonly expiresAt: number;
}

export function parseDeviceRecoveryRecord(value: unknown): DeviceRecoveryRecord {
  const record = value as DeviceRecoveryRecord | null;
  if (!record || record.version !== 1 || typeof record.baseUrl !== "string"
    || canonicalControlOrigin(record.baseUrl) !== record.baseUrl
    || typeof record.deviceId !== "string" || !/^device_[A-Za-z0-9_-]{43}$/.test(record.deviceId)
    || typeof record.publicKey !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(record.publicKey)
    || typeof record.privateKeyPkcs8 !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(record.privateKeyPkcs8)
    || !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= 0) {
    throw new BrowserSecurityError("RECOVERY_RECORD_INVALID");
  }
  parseRemoteControlHostId(record.hostId);
  // Pick fields explicitly; no old credential, channel or replay state is restored.
  return Object.freeze({ version: 1, baseUrl: record.baseUrl, hostId: record.hostId,
    deviceId: record.deviceId, publicKey: record.publicKey, privateKeyPkcs8: record.privateKeyPkcs8,
    expiresAt: record.expiresAt });
}

export function validateDeviceRecoveryMetadata(
  value: unknown,
  expected: Pick<DeviceRecoveryMetadata, "hostId" | "deviceId" | "publicKey">,
  maximumExpiresAt: number,
): DeviceRecoveryMetadata {
  const metadata = value as DeviceRecoveryMetadata | null;
  if (!metadata || metadata.version !== 1 || metadata.hostId !== expected.hostId
    || metadata.deviceId !== expected.deviceId || metadata.publicKey !== expected.publicKey
    || !Number.isSafeInteger(metadata.expiresAt) || metadata.expiresAt <= Date.now()
    // Use the host-issued pairing interval (or saved deadline during recovery),
    // not phone time + TTL: the two clocks need not agree to the millisecond.
    || !Number.isSafeInteger(maximumExpiresAt) || metadata.expiresAt > maximumExpiresAt) {
    throw new BrowserSecurityError("RECOVERY_METADATA_INVALID");
  }
  return Object.freeze({ version: 1, hostId: metadata.hostId, deviceId: metadata.deviceId,
    publicKey: metadata.publicKey, expiresAt: metadata.expiresAt });
}

export async function createRecoverableDeviceIdentity(crypto: Crypto): Promise<{ identity: BrowserDeviceIdentity; privateKeyPkcs8: string }> {
  try {
    const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
    const publicKey = encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)));
    const privateBytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    const privateKeyPkcs8 = encodeBase64Url(privateBytes);
    privateBytes.fill(0);
    const deviceId = `device_${encodeBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", decodeBase64Url(publicKey, 128))))}`;
    const identity = await restoreDeviceIdentity({ publicKey, privateKeyPkcs8, deviceId }, crypto);
    // Probe HKDF and AES before consuming a one-time pairing code too.
    await sealBrowserRelayEnvelope({ hostId: "native_probe", routeId: "route_probe",
      key: encodeBase64Url(crypto.getRandomValues(new Uint8Array(32))) }, "device_to_host", {}, crypto);
    return { identity, privateKeyPkcs8 };
  } catch {
    throw new BrowserSecurityError("BROWSER_CRYPTO_UNSUPPORTED");
  }
}

export async function restoreDeviceIdentity(record: Pick<DeviceRecoveryRecord, "publicKey" | "privateKeyPkcs8" | "deviceId">, crypto: Crypto): Promise<BrowserDeviceIdentity> {
  try {
    const publicBytes = decodeBase64Url(record.publicKey, 128);
    const digest = encodeBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", publicBytes)));
    if (record.deviceId !== `device_${digest}`) throw new Error("MISMATCH");
    const privateBytes = decodeBase64Url(record.privateKeyPkcs8, 256);
    let privateKey: CryptoKey;
    try { privateKey = await crypto.subtle.importKey("pkcs8", privateBytes, "Ed25519", false, ["sign"]); }
    finally { privateBytes.fill(0); }
    const publicKey = await crypto.subtle.importKey("spki", publicBytes, "Ed25519", false, ["verify"]);
    const probe = crypto.getRandomValues(new Uint8Array(32));
    const signature = await crypto.subtle.sign("Ed25519", privateKey, probe);
    if (!await crypto.subtle.verify("Ed25519", publicKey, signature, probe)) throw new Error("MISMATCH");
    return Object.freeze({ algorithm: "Ed25519", deviceId: record.deviceId, publicKey: record.publicKey, privateKey });
  } catch { throw new BrowserSecurityError("RECOVERY_IDENTITY_INVALID"); }
}
