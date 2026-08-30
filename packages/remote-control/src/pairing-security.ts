import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes as nodeRandomBytes,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto";
import {
  REMOTE_CONTROL_CAPABILITIES,
  REMOTE_CONTROL_LIMITS,
  type RemoteControlCapability,
  type RemoteControlRelayDirection,
} from "./protocol.js";

const PAIRING_PROOF_DOMAIN = "chili.remote-control.pairing-proof.v1";
const RELAY_AEAD_DOMAIN = "chili.remote-control.relay-aead.v1";
const DEVICE_ID_PREFIX = "device_";
const ROUTE_ID_PREFIX = "route_";
const MESSAGE_ID_PREFIX = "message_";
const CREDENTIAL_PREFIX = "chili_rc1";
const AES_KEY_BYTES = 32;
const AES_GCM_NONCE_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;
const ED25519_SIGNATURE_BYTES = 64;
const PAIRING_NONCE_BYTES = 32;
const CREDENTIAL_ID_BYTES = 16;
const CREDENTIAL_SECRET_BYTES = 32;
const CREDENTIAL_SALT_BYTES = 16;
const DEFAULT_PAIRING_NONCE_TTL_MS = 2 * 60 * 1_000;
const DEFAULT_CREDENTIAL_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_PENDING_PAIRINGS = 128;
const DEFAULT_MAX_PAIRING_PROOF_ATTEMPTS = 5;
const DEFAULT_MAX_CREDENTIAL_RECORDS = 256;
const DEFAULT_MAX_ACTIVE_CHANNELS = 128;
const DEFAULT_MAX_REPLAY_ENTRIES = 4_096;
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

export { REMOTE_CONTROL_CAPABILITIES };
export type RemoteCapability = RemoteControlCapability;
export type RelayDirection = RemoteControlRelayDirection;
export type Clock = () => number;
export type RandomBytesSource = (size: number) => Uint8Array;

export type PairingSecurityErrorCode =
  | "DEVICE_KEY_INVALID"
  | "DEVICE_ID_MISMATCH"
  | "PAIRING_NONCE_INVALID"
  | "PAIRING_NONCE_EXPIRED"
  | "PAIRING_NONCE_REUSED"
  | "PAIRING_PROOF_INVALID"
  | "PAIRING_PROOF_ATTEMPTS_EXCEEDED"
  | "PAIRING_LIMIT_EXCEEDED"
  | "CAPABILITY_NOT_ALLOWED"
  | "CREDENTIAL_INVALID"
  | "CREDENTIAL_EXPIRED"
  | "CREDENTIAL_REVOKED"
  | "CREDENTIAL_LIMIT_EXCEEDED"
  | "DEVICE_MISMATCH"
  | "HOST_MISMATCH"
  | "ROUTE_MISMATCH"
  | "CAPABILITY_DENIED"
  | "RELAY_ROUTE_UNKNOWN"
  | "CHANNEL_LIMIT_EXCEEDED"
  | "RELAY_ENVELOPE_INVALID"
  | "RELAY_DECRYPTION_FAILED"
  | "RELAY_REPLAYED"
  | "RELAY_REPLAY_WINDOW_EXHAUSTED"
  | "MESSAGE_TOO_LARGE"
  | "RANDOM_SOURCE_INVALID";

/** Security failures deliberately carry stable codes and no attacker-controlled text. */
export class PairingSecurityError extends Error {
  readonly code: PairingSecurityErrorCode;

  constructor(code: PairingSecurityErrorCode) {
    super(code);
    this.name = "PairingSecurityError";
    this.code = code;
  }
}

export interface DeviceIdentity {
  algorithm: "Ed25519";
  /** SHA-256 of the canonical Ed25519 SPKI bytes. */
  deviceId: string;
  /** Canonical base64url-encoded SPKI DER. Safe to share with the host. */
  publicKey: string;
  /** Canonical base64url-encoded PKCS#8 DER. Device-local secret. */
  privateKey: string;
}

export interface PairingChallenge {
  version: 1;
  hostId: string;
  deviceId: string;
  publicKey: string;
  routeId: string;
  nonce: string;
  capabilities: readonly RemoteCapability[];
  issuedAt: number;
  expiresAt: number;
}

export interface PairingProof {
  version: 1;
  nonce: string;
  signature: string;
}

export interface BeginPairingInput {
  deviceId: string;
  publicKey: string;
  /** Exact host-approved offer; this API is not a device capability request surface. */
  grantedCapabilities: readonly RemoteCapability[];
}

export interface CredentialRecord {
  /** Non-secret lookup handle embedded in the bearer presentation. */
  credentialId: string;
  /** Random salt; the bearer presentation itself is never retained. */
  credentialSalt: string;
  /** SHA-256(salt || UTF-8 bearer presentation), encoded as lowercase hex. */
  credentialHash: string;
  hostId: string;
  deviceId: string;
  routeId: string;
  capabilities: readonly RemoteCapability[];
  issuedAt: number;
  expiresAt: number;
  revokedAt?: number;
}

export interface IssuedCredential {
  /** Returned exactly once to the paired device and never retained by the store. */
  credential: string;
  record: CredentialRecord;
}

export interface CredentialAuthorization {
  credentialHash: string;
  hostId: string;
  deviceId: string;
  routeId: string;
  capabilities: readonly RemoteCapability[];
  issuedAt: number;
  expiresAt: number;
}

export interface IssueCredentialInput {
  hostId: string;
  deviceId: string;
  routeId: string;
  capabilities: readonly RemoteCapability[];
  ttlMs?: number;
}

export interface AuthenticateCredentialInput {
  credential: string;
  hostId: string;
  deviceId: string;
  routeId: string;
  capability: RemoteCapability;
}

export interface InMemoryCredentialStoreOptions {
  clock?: Clock;
  randomBytes?: RandomBytesSource;
  defaultTtlMs?: number;
  maxRecords?: number;
}

interface MutableCredentialRecord extends CredentialRecord {
  revokedAt?: number;
}

export interface RelayChannelKey {
  /** Stable host identity; local/inner-only and never relay-visible. */
  hostId: string;
  routeId: string;
  /** Independent random root key. Directional AES keys are derived with HKDF. */
  key: string;
}

/** Structurally compatible with protocol.OpaqueRelayEnvelope. */
export interface SealedRelayEnvelope {
  version: 1;
  routeId: string;
  direction: RelayDirection;
  messageId: string;
  /** AES-GCM nonce || ciphertext || authentication tag. */
  ciphertext: Uint8Array;
  byteLength: number;
  createdAt: number;
}

export interface SealRelayEnvelopeOptions {
  clock?: Clock;
  randomBytes?: RandomBytesSource;
  messageId?: string;
  createdAt?: number;
  maxPlaintextBytes?: number;
}

export interface OpenRelayEnvelopeOptions {
  expectedDirection?: RelayDirection;
  maxCiphertextBytes?: number;
  replayGuard?: RelayReplayGuard;
}

export interface CreateRelayChannelKeyOptions {
  hostId: string;
  routeId?: string;
  randomBytes?: RandomBytesSource;
}

export interface PairingGrant {
  hostId: string;
  deviceId: string;
  credential: string;
  capabilities: readonly RemoteCapability[];
  issuedAt: number;
  expiresAt: number;
  channel: RelayChannelKey;
}

export interface InMemoryPairingAuthorityOptions {
  hostId: string;
  allowedCapabilities: readonly RemoteCapability[];
  clock?: Clock;
  randomBytes?: RandomBytesSource;
  pairingNonceTtlMs?: number;
  credentialTtlMs?: number;
  maxPendingPairings?: number;
  maxPairingProofAttempts?: number;
  maxCredentialRecords?: number;
  maxActiveChannels?: number;
  credentialStore?: InMemoryCredentialStore;
}

interface StoredPairingChallenge {
  nonceHash: string;
  hostId: string;
  deviceId: string;
  publicKey: string;
  routeId: string;
  capabilities: readonly RemoteCapability[];
  issuedAt: number;
  expiresAt: number;
  failedProofAttempts: number;
  consumedAt?: number;
}

/** Generate a device-local Ed25519 identity. */
export function generateDeviceIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyBytes = publicKey.export({ format: "der", type: "spki" });
  const privateKeyBytes = privateKey.export({ format: "der", type: "pkcs8" });
  const encodedPublicKey = publicKeyBytes.toString("base64url");
  return Object.freeze({
    algorithm: "Ed25519",
    deviceId: deviceIdFromCanonicalPublicKey(publicKeyBytes),
    publicKey: encodedPublicKey,
    privateKey: privateKeyBytes.toString("base64url"),
  });
}

/** Derive the only valid device id for a supplied canonical Ed25519 public key. */
export function deriveDeviceId(publicKey: string): string {
  const canonical = canonicalPublicKey(publicKey);
  return deviceIdFromCanonicalPublicKey(canonical.bytes);
}

/** Sign the complete, domain-separated pairing challenge with the device identity. */
export function createPairingProof(
  challenge: PairingChallenge,
  privateKey: string,
): PairingProof {
  try {
    const keyBytes = decodeCanonicalBase64Url(privateKey, "DEVICE_KEY_INVALID", 80);
    const key = createPrivateKey({ key: keyBytes, format: "der", type: "pkcs8" });
    if (key.asymmetricKeyType !== "ed25519") {
      throw new PairingSecurityError("DEVICE_KEY_INVALID");
    }
    const signature = sign(null, pairingProofTranscript(challenge), key);
    return Object.freeze({
      version: 1,
      nonce: challenge.nonce,
      signature: signature.toString("base64url"),
    });
  } catch (error) {
    if (error instanceof PairingSecurityError) throw error;
    throw new PairingSecurityError("DEVICE_KEY_INVALID");
  }
}

/** Hash a credential with its record-specific salt. */
export function hashCredential(credential: string, credentialSalt: string): string {
  if (typeof credential !== "string"
    || credential.length > REMOTE_CONTROL_LIMITS.maxCredentialChars) {
    throw new PairingSecurityError("CREDENTIAL_INVALID");
  }
  const salt = decodeCanonicalBase64Url(
    credentialSalt,
    "CREDENTIAL_INVALID",
    CREDENTIAL_SALT_BYTES,
  );
  if (salt.byteLength !== CREDENTIAL_SALT_BYTES || typeof credential !== "string") {
    throw new PairingSecurityError("CREDENTIAL_INVALID");
  }
  return createHash("sha256")
    .update(salt)
    .update(Buffer.from(credential, "utf8"))
    .digest("hex");
}

/**
 * Host-side credential storage. The random bearer presentation is returned to
 * the caller once; only its non-secret id, salt, and digest remain in memory.
 */
export class InMemoryCredentialStore {
  readonly #clock: Clock;
  readonly #randomBytes: RandomBytesSource;
  readonly #defaultTtlMs: number;
  readonly #maxRecords: number;
  readonly #recordsById = new Map<string, MutableCredentialRecord>();
  readonly #recordsByHash = new Map<string, MutableCredentialRecord>();

  constructor(options: InMemoryCredentialStoreOptions = {}) {
    this.#clock = options.clock ?? Date.now;
    this.#randomBytes = options.randomBytes ?? defaultRandomBytes;
    this.#defaultTtlMs = positiveSafeInteger(
      options.defaultTtlMs ?? DEFAULT_CREDENTIAL_TTL_MS,
      "CREDENTIAL_INVALID",
    );
    this.#maxRecords = positiveSafeInteger(
      options.maxRecords ?? DEFAULT_MAX_CREDENTIAL_RECORDS,
      "CREDENTIAL_LIMIT_EXCEEDED",
    );
  }

  issue(input: IssueCredentialInput): IssuedCredential {
    if (this.#recordsById.size >= this.#maxRecords) {
      throw new PairingSecurityError("CREDENTIAL_LIMIT_EXCEEDED");
    }
    assertHostId(input.hostId);
    assertDeviceIdShape(input.deviceId);
    assertOpaqueId(input.routeId, "ROUTE_MISMATCH");
    const capabilities = normalizeCapabilities(input.capabilities);
    const now = readClock(this.#clock);
    const ttlMs = positiveSafeInteger(
      input.ttlMs ?? this.#defaultTtlMs,
      "CREDENTIAL_INVALID",
    );
    const expiresAt = safeExpiry(now, ttlMs, "CREDENTIAL_INVALID");

    let credentialId = "";
    for (let attempt = 0; attempt < 4; attempt += 1) {
      credentialId = randomBytesExact(CREDENTIAL_ID_BYTES, this.#randomBytes).toString("base64url");
      if (!this.#recordsById.has(credentialId)) break;
      credentialId = "";
    }
    if (!credentialId) throw new PairingSecurityError("RANDOM_SOURCE_INVALID");

    const secret = randomBytesExact(CREDENTIAL_SECRET_BYTES, this.#randomBytes).toString("base64url");
    const credential = `${CREDENTIAL_PREFIX}_${credentialId}_${secret}`;
    const credentialSalt = randomBytesExact(
      CREDENTIAL_SALT_BYTES,
      this.#randomBytes,
    ).toString("base64url");
    const credentialHash = hashCredential(credential, credentialSalt);
    const record: MutableCredentialRecord = {
      credentialId,
      credentialSalt,
      credentialHash,
      hostId: input.hostId,
      deviceId: input.deviceId,
      routeId: input.routeId,
      capabilities,
      issuedAt: now,
      expiresAt,
    };
    this.#recordsById.set(credentialId, record);
    this.#recordsByHash.set(credentialHash, record);
    return {
      credential,
      record: publicCredentialRecord(record),
    };
  }

  authenticate(input: AuthenticateCredentialInput): CredentialAuthorization {
    if (typeof input.credential !== "string"
      || input.credential.length > REMOTE_CONTROL_LIMITS.maxCredentialChars) {
      throw new PairingSecurityError("CREDENTIAL_INVALID");
    }
    const parsed = parseCredential(input.credential);
    const record = parsed ? this.#recordsById.get(parsed.credentialId) : undefined;
    if (!record || !credentialDigestMatches(record, input.credential)) {
      performDummyCredentialComparison(input.credential);
      throw new PairingSecurityError("CREDENTIAL_INVALID");
    }

    const now = readClock(this.#clock);
    if (record.revokedAt !== undefined) {
      throw new PairingSecurityError("CREDENTIAL_REVOKED");
    }
    if (now >= record.expiresAt) {
      throw new PairingSecurityError("CREDENTIAL_EXPIRED");
    }
    if (input.hostId !== record.hostId) {
      throw new PairingSecurityError("HOST_MISMATCH");
    }
    if (input.deviceId !== record.deviceId) {
      throw new PairingSecurityError("DEVICE_MISMATCH");
    }
    if (input.routeId !== record.routeId) {
      throw new PairingSecurityError("ROUTE_MISMATCH");
    }
    if (!record.capabilities.includes(input.capability)) {
      throw new PairingSecurityError("CAPABILITY_DENIED");
    }

    return Object.freeze({
      credentialHash: record.credentialHash,
      hostId: record.hostId,
      deviceId: record.deviceId,
      routeId: record.routeId,
      capabilities: Object.freeze([...record.capabilities]),
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
    });
  }

  /** Revoke by bearer presentation. Invalid presentations do not reveal lookup state. */
  revokeCredential(credential: string): boolean {
    if (typeof credential !== "string"
      || credential.length > REMOTE_CONTROL_LIMITS.maxCredentialChars) return false;
    const parsed = parseCredential(credential);
    const record = parsed ? this.#recordsById.get(parsed.credentialId) : undefined;
    if (!record || !credentialDigestMatches(record, credential)) {
      performDummyCredentialComparison(credential);
      return false;
    }
    if (record.revokedAt === undefined) record.revokedAt = readClock(this.#clock);
    return true;
  }

  /** Host-admin revocation path that does not require retaining the bearer. */
  revokeCredentialHash(credentialHash: string): boolean {
    if (!/^[a-f0-9]{64}$/.test(credentialHash)) return false;
    const record = this.#recordsByHash.get(credentialHash);
    if (!record) return false;
    const candidate = Buffer.from(credentialHash, "hex");
    const expected = Buffer.from(record.credentialHash, "hex");
    if (!timingSafeEqual(candidate, expected)) return false;
    if (record.revokedAt === undefined) record.revokedAt = readClock(this.#clock);
    return true;
  }

  revokeDevice(deviceId: string): number {
    const now = readClock(this.#clock);
    let revoked = 0;
    for (const record of this.#recordsById.values()) {
      if (record.deviceId !== deviceId || record.revokedAt !== undefined) continue;
      record.revokedAt = now;
      revoked += 1;
    }
    return revoked;
  }

  getRecordByHash(credentialHash: string): CredentialRecord | undefined {
    const record = this.#recordsByHash.get(credentialHash);
    return record ? publicCredentialRecord(record) : undefined;
  }

  /** Safe diagnostic snapshot: contains hashes and metadata, never bearer presentations. */
  snapshot(): readonly CredentialRecord[] {
    return Object.freeze(
      [...this.#recordsById.values()].map((record) => publicCredentialRecord(record)),
    );
  }
}

/**
 * Host-side one-time pairing authority. Pending challenges retain only a nonce
 * digest; the proof supplies the nonce needed to reconstruct the transcript.
 */
export class InMemoryPairingAuthority {
  readonly credentialStore: InMemoryCredentialStore;
  readonly #hostId: string;
  readonly #allowedCapabilities: ReadonlySet<RemoteCapability>;
  readonly #clock: Clock;
  readonly #randomBytes: RandomBytesSource;
  readonly #pairingNonceTtlMs: number;
  readonly #credentialTtlMs: number;
  readonly #maxPendingPairings: number;
  readonly #maxPairingProofAttempts: number;
  readonly #maxActiveChannels: number;
  readonly #pendingByNonceHash = new Map<string, StoredPairingChallenge>();
  readonly #channelsByRouteId = new Map<string, RelayChannelKey>();

  constructor(options: InMemoryPairingAuthorityOptions) {
    assertHostId(options.hostId);
    this.#hostId = options.hostId;
    const allowed = normalizeCapabilities(options.allowedCapabilities);
    this.#allowedCapabilities = new Set(allowed);
    this.#clock = options.clock ?? Date.now;
    this.#randomBytes = options.randomBytes ?? defaultRandomBytes;
    this.#pairingNonceTtlMs = positiveSafeInteger(
      options.pairingNonceTtlMs ?? DEFAULT_PAIRING_NONCE_TTL_MS,
      "PAIRING_NONCE_INVALID",
    );
    this.#credentialTtlMs = positiveSafeInteger(
      options.credentialTtlMs ?? DEFAULT_CREDENTIAL_TTL_MS,
      "CREDENTIAL_INVALID",
    );
    this.#maxPendingPairings = positiveSafeInteger(
      options.maxPendingPairings ?? DEFAULT_MAX_PENDING_PAIRINGS,
      "PAIRING_LIMIT_EXCEEDED",
    );
    this.#maxPairingProofAttempts = positiveSafeInteger(
      options.maxPairingProofAttempts ?? DEFAULT_MAX_PAIRING_PROOF_ATTEMPTS,
      "PAIRING_PROOF_ATTEMPTS_EXCEEDED",
    );
    this.#maxActiveChannels = positiveSafeInteger(
      options.maxActiveChannels ?? DEFAULT_MAX_ACTIVE_CHANNELS,
      "CHANNEL_LIMIT_EXCEEDED",
    );
    this.credentialStore = options.credentialStore ?? new InMemoryCredentialStore({
      clock: this.#clock,
      randomBytes: this.#randomBytes,
      defaultTtlMs: this.#credentialTtlMs,
      maxRecords: options.maxCredentialRecords ?? DEFAULT_MAX_CREDENTIAL_RECORDS,
    });
  }

  beginPairing(input: BeginPairingInput): PairingChallenge {
    const canonicalKey = canonicalPublicKey(input.publicKey);
    const derivedDeviceId = deviceIdFromCanonicalPublicKey(canonicalKey.bytes);
    if (input.deviceId !== derivedDeviceId) {
      throw new PairingSecurityError("DEVICE_ID_MISMATCH");
    }
    const capabilities = normalizeCapabilities(input.grantedCapabilities);
    for (const capability of capabilities) {
      if (!this.#allowedCapabilities.has(capability)) {
        throw new PairingSecurityError("CAPABILITY_NOT_ALLOWED");
      }
    }

    const now = readClock(this.#clock);
    this.#purgeExpiredPairings(now);
    if (this.#pendingByNonceHash.size >= this.#maxPendingPairings) {
      throw new PairingSecurityError("PAIRING_LIMIT_EXCEEDED");
    }

    let nonce = "";
    let nonceHash = "";
    for (let attempt = 0; attempt < 4; attempt += 1) {
      nonce = randomToken("pair", PAIRING_NONCE_BYTES, this.#randomBytes);
      nonceHash = digestHex(nonce);
      if (!this.#pendingByNonceHash.has(nonceHash)) break;
      nonce = "";
      nonceHash = "";
    }
    if (!nonce || !nonceHash) throw new PairingSecurityError("RANDOM_SOURCE_INVALID");

    let routeId = "";
    for (let attempt = 0; attempt < 4; attempt += 1) {
      routeId = `${ROUTE_ID_PREFIX}${randomBytesExact(18, this.#randomBytes).toString("base64url")}`;
      const routePending = [...this.#pendingByNonceHash.values()]
        .some((pending) => pending.routeId === routeId);
      if (!routePending && !this.#channelsByRouteId.has(routeId)) break;
      routeId = "";
    }
    if (!routeId) throw new PairingSecurityError("RANDOM_SOURCE_INVALID");

    const expiresAt = safeExpiry(now, this.#pairingNonceTtlMs, "PAIRING_NONCE_INVALID");
    const challenge: PairingChallenge = Object.freeze({
      version: 1,
      hostId: this.#hostId,
      deviceId: derivedDeviceId,
      publicKey: canonicalKey.encoded,
      routeId,
      nonce,
      capabilities,
      issuedAt: now,
      expiresAt,
    });
    this.#pendingByNonceHash.set(nonceHash, {
      nonceHash,
      hostId: challenge.hostId,
      deviceId: challenge.deviceId,
      publicKey: challenge.publicKey,
      routeId: challenge.routeId,
      capabilities: challenge.capabilities,
      issuedAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt,
      failedProofAttempts: 0,
    });
    return challenge;
  }

  completePairing(proof: PairingProof): PairingGrant {
    if (proof.version !== 1
      || typeof proof.nonce !== "string"
      || proof.nonce.length !== "pair_".length + 43
      || !/^pair_[A-Za-z0-9_-]{43}$/.test(proof.nonce)) {
      throw new PairingSecurityError("PAIRING_NONCE_INVALID");
    }
    const stored = this.#pendingByNonceHash.get(digestHex(proof.nonce));
    if (!stored) throw new PairingSecurityError("PAIRING_NONCE_INVALID");
    if (stored.consumedAt !== undefined) {
      throw new PairingSecurityError("PAIRING_NONCE_REUSED");
    }
    if (stored.failedProofAttempts >= this.#maxPairingProofAttempts) {
      throw new PairingSecurityError("PAIRING_PROOF_ATTEMPTS_EXCEEDED");
    }
    const now = readClock(this.#clock);
    if (now >= stored.expiresAt) {
      throw new PairingSecurityError("PAIRING_NONCE_EXPIRED");
    }

    const challenge: PairingChallenge = {
      version: 1,
      hostId: stored.hostId,
      deviceId: stored.deviceId,
      publicKey: stored.publicKey,
      routeId: stored.routeId,
      nonce: proof.nonce,
      capabilities: stored.capabilities,
      issuedAt: stored.issuedAt,
      expiresAt: stored.expiresAt,
    };
    if (!verifyPairingProof(challenge, proof.signature)) {
      // An invalid proof must not consume the one-time challenge (DoS resistance).
      stored.failedProofAttempts += 1;
      throw new PairingSecurityError(
        stored.failedProofAttempts >= this.#maxPairingProofAttempts
          ? "PAIRING_PROOF_ATTEMPTS_EXCEEDED"
          : "PAIRING_PROOF_INVALID",
      );
    }

    if (this.#channelsByRouteId.size >= this.#maxActiveChannels) {
      throw new PairingSecurityError("CHANNEL_LIMIT_EXCEEDED");
    }

    const channel = createRelayChannelKey({
      hostId: stored.hostId,
      routeId: stored.routeId,
      randomBytes: this.#randomBytes,
    });
    const issued = this.credentialStore.issue({
      hostId: stored.hostId,
      deviceId: stored.deviceId,
      routeId: stored.routeId,
      capabilities: stored.capabilities,
      ttlMs: this.#credentialTtlMs,
    });

    // All fallible cryptographic preparation completed; commit both states together.
    stored.consumedAt = now;
    this.#channelsByRouteId.set(stored.routeId, channel);
    return Object.freeze({
      hostId: stored.hostId,
      deviceId: stored.deviceId,
      credential: issued.credential,
      capabilities: Object.freeze([...stored.capabilities]),
      issuedAt: issued.record.issuedAt,
      expiresAt: issued.record.expiresAt,
      channel,
    });
  }

  authenticate(input: AuthenticateCredentialInput): CredentialAuthorization {
    return this.credentialStore.authenticate(input);
  }

  revokeCredential(credential: string): boolean {
    return this.credentialStore.revokeCredential(credential);
  }

  revokeDevice(deviceId: string): number {
    return this.credentialStore.revokeDevice(deviceId);
  }

  openRelayEnvelope<T>(
    envelope: unknown,
    options: OpenRelayEnvelopeOptions = {},
  ): T {
    const routeId = relayEnvelopeRouteId(envelope);
    const channel = this.#channelsByRouteId.get(routeId);
    if (!channel) throw new PairingSecurityError("RELAY_ROUTE_UNKNOWN");
    return openRelayEnvelope<T>(channel, envelope, options);
  }

  sealRelayEnvelope<T>(
    routeId: string,
    direction: RelayDirection,
    inner: T,
    options: SealRelayEnvelopeOptions = {},
  ): SealedRelayEnvelope {
    const channel = this.#channelsByRouteId.get(routeId);
    if (!channel) throw new PairingSecurityError("RELAY_ROUTE_UNKNOWN");
    return sealRelayEnvelope(channel, direction, inner, {
      clock: options.clock ?? this.#clock,
      randomBytes: options.randomBytes ?? this.#randomBytes,
      ...(options.messageId === undefined ? {} : { messageId: options.messageId }),
      ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
      ...(options.maxPlaintextBytes === undefined
        ? {}
        : { maxPlaintextBytes: options.maxPlaintextBytes }),
    });
  }

  get pendingPairingCount(): number {
    return this.#pendingByNonceHash.size;
  }

  #purgeExpiredPairings(now: number): void {
    for (const [nonceHash, pending] of this.#pendingByNonceHash) {
      if (now >= pending.expiresAt) this.#pendingByNonceHash.delete(nonceHash);
    }
  }
}

export function createRelayChannelKey(
  options: CreateRelayChannelKeyOptions,
): RelayChannelKey {
  const randomBytes = options.randomBytes ?? defaultRandomBytes;
  assertHostId(options.hostId);
  const routeId = options.routeId
    ?? `${ROUTE_ID_PREFIX}${randomBytesExact(18, randomBytes).toString("base64url")}`;
  assertOpaqueId(routeId, "ROUTE_MISMATCH");
  return Object.freeze({
    hostId: options.hostId,
    routeId,
    key: randomBytesExact(AES_KEY_BYTES, randomBytes).toString("base64url"),
  });
}

/** Encrypt an arbitrary JSON inner frame into an opaque relay envelope. */
export function sealRelayEnvelope<T>(
  channel: RelayChannelKey,
  direction: RelayDirection,
  inner: T,
  options: SealRelayEnvelopeOptions = {},
): SealedRelayEnvelope {
  const key = deriveDirectionalChannelKey(channel, direction);
  assertRelayDirection(direction);
  const randomBytes = options.randomBytes ?? defaultRandomBytes;
  const clock = options.clock ?? Date.now;
  const createdAt = options.createdAt ?? readClock(clock);
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new PairingSecurityError("RELAY_ENVELOPE_INVALID");
  }
  const messageId = options.messageId
    ?? `${MESSAGE_ID_PREFIX}${randomBytesExact(16, randomBytes).toString("base64url")}`;
  assertOpaqueId(messageId, "RELAY_ENVELOPE_INVALID");

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(inner);
  } catch {
    throw new PairingSecurityError("RELAY_ENVELOPE_INVALID");
  }
  if (serialized === undefined) throw new PairingSecurityError("RELAY_ENVELOPE_INVALID");
  const plaintext = Buffer.from(serialized, "utf8");
  const maxPlaintextBytes = positiveSafeInteger(
    options.maxPlaintextBytes ?? REMOTE_CONTROL_LIMITS.maxFrameBytes,
    "MESSAGE_TOO_LARGE",
  );
  if (plaintext.byteLength > maxPlaintextBytes) {
    throw new PairingSecurityError("MESSAGE_TOO_LARGE");
  }

  const byteLength = AES_GCM_NONCE_BYTES + plaintext.byteLength + AES_GCM_TAG_BYTES;
  const aad = relayAad(channel, {
    version: 1,
    routeId: channel.routeId,
    direction,
    messageId,
    byteLength,
    createdAt,
  });
  const nonce = randomBytesExact(AES_GCM_NONCE_BYTES, randomBytes);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: AES_GCM_TAG_BYTES });
  cipher.setAAD(aad, { plaintextLength: plaintext.byteLength });
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const ciphertext = Buffer.concat([nonce, encrypted, cipher.getAuthTag()]);
  return Object.freeze({
    version: 1,
    routeId: channel.routeId,
    direction,
    messageId,
    ciphertext,
    byteLength: ciphertext.byteLength,
    createdAt,
  });
}

/** Authenticate/decrypt an opaque relay envelope. No plaintext is available on failure. */
export function openRelayEnvelope<T>(
  channel: RelayChannelKey,
  envelope: unknown,
  options: OpenRelayEnvelopeOptions = {},
): T {
  const parsed = parseSealedRelayEnvelope(envelope, options.maxCiphertextBytes);
  if (parsed.routeId !== channel.routeId) {
    throw new PairingSecurityError("ROUTE_MISMATCH");
  }
  if (options.expectedDirection !== undefined
    && parsed.direction !== options.expectedDirection) {
    throw new PairingSecurityError("RELAY_ENVELOPE_INVALID");
  }
  if (options.replayGuard?.has(parsed)) {
    throw new PairingSecurityError("RELAY_REPLAYED");
  }

  const key = deriveDirectionalChannelKey(channel, parsed.direction);
  const packed = Buffer.from(parsed.ciphertext);
  const nonce = packed.subarray(0, AES_GCM_NONCE_BYTES);
  const tag = packed.subarray(packed.byteLength - AES_GCM_TAG_BYTES);
  const encrypted = packed.subarray(AES_GCM_NONCE_BYTES, packed.byteLength - AES_GCM_TAG_BYTES);
  const aad = relayAad(channel, parsed);

  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, {
      authTagLength: AES_GCM_TAG_BYTES,
    });
    decipher.setAAD(aad, { plaintextLength: encrypted.byteLength });
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch {
    throw new PairingSecurityError("RELAY_DECRYPTION_FAILED");
  }

  let inner: T;
  try {
    inner = JSON.parse(fatalUtf8Decoder.decode(plaintext)) as T;
  } catch {
    throw new PairingSecurityError("RELAY_ENVELOPE_INVALID");
  }
  options.replayGuard?.record(parsed);
  return inner;
}

/** Bounded connection-local replay protection for authenticated message ids. */
export class RelayReplayGuard {
  readonly #maxEntries: number;
  readonly #seen = new Set<string>();

  constructor(maxEntries = DEFAULT_MAX_REPLAY_ENTRIES) {
    this.#maxEntries = positiveSafeInteger(maxEntries, "RELAY_REPLAY_WINDOW_EXHAUSTED");
  }

  has(envelope: Pick<SealedRelayEnvelope, "routeId" | "direction" | "messageId">): boolean {
    return this.#seen.has(replayKey(envelope));
  }

  record(envelope: Pick<SealedRelayEnvelope, "routeId" | "direction" | "messageId">): void {
    const key = replayKey(envelope);
    if (this.#seen.has(key)) throw new PairingSecurityError("RELAY_REPLAYED");
    if (this.#seen.size >= this.#maxEntries) {
      throw new PairingSecurityError("RELAY_REPLAY_WINDOW_EXHAUSTED");
    }
    this.#seen.add(key);
  }

  get size(): number {
    return this.#seen.size;
  }

  clear(): void {
    this.#seen.clear();
  }
}

function verifyPairingProof(challenge: PairingChallenge, encodedSignature: string): boolean {
  try {
    const signature = decodeCanonicalBase64Url(
      encodedSignature,
      "PAIRING_PROOF_INVALID",
      ED25519_SIGNATURE_BYTES,
    );
    if (signature.byteLength !== ED25519_SIGNATURE_BYTES) return false;
    const canonical = canonicalPublicKey(challenge.publicKey);
    const key = createPublicKey({ key: canonical.bytes, format: "der", type: "spki" });
    return verify(null, pairingProofTranscript(challenge), key, signature);
  } catch {
    return false;
  }
}

function pairingProofTranscript(challenge: PairingChallenge): Buffer {
  return Buffer.from(JSON.stringify({
    domain: PAIRING_PROOF_DOMAIN,
    version: challenge.version,
    hostId: challenge.hostId,
    deviceId: challenge.deviceId,
    publicKey: challenge.publicKey,
    routeId: challenge.routeId,
    nonce: challenge.nonce,
    capabilities: [...challenge.capabilities],
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
  }), "utf8");
}

function canonicalPublicKey(encoded: string): { encoded: string; bytes: Buffer } {
  try {
    const bytes = decodeCanonicalBase64Url(encoded, "DEVICE_KEY_INVALID", 64);
    const key = createPublicKey({ key: bytes, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") {
      throw new PairingSecurityError("DEVICE_KEY_INVALID");
    }
    const canonicalBytes = key.export({ format: "der", type: "spki" });
    return {
      encoded: canonicalBytes.toString("base64url"),
      bytes: Buffer.from(canonicalBytes),
    };
  } catch (error) {
    if (error instanceof PairingSecurityError) throw error;
    throw new PairingSecurityError("DEVICE_KEY_INVALID");
  }
}

function deviceIdFromCanonicalPublicKey(publicKeyBytes: Uint8Array): string {
  return `${DEVICE_ID_PREFIX}${createHash("sha256").update(publicKeyBytes).digest("base64url")}`;
}

function normalizeCapabilities(
  capabilities: readonly RemoteCapability[],
): readonly RemoteCapability[] {
  if (!Array.isArray(capabilities) || capabilities.length === 0
    || capabilities.length > REMOTE_CONTROL_CAPABILITIES.length) {
    throw new PairingSecurityError("CAPABILITY_NOT_ALLOWED");
  }
  const unique = new Set<RemoteCapability>();
  for (const rawCapability of capabilities as readonly unknown[]) {
    if (!isRemoteCapability(rawCapability) || unique.has(rawCapability)) {
      throw new PairingSecurityError("CAPABILITY_NOT_ALLOWED");
    }
    unique.add(rawCapability);
  }
  return Object.freeze(
    REMOTE_CONTROL_CAPABILITIES.filter((capability) => unique.has(capability)),
  );
}

function isRemoteCapability(value: unknown): value is RemoteCapability {
  return typeof value === "string"
    && (REMOTE_CONTROL_CAPABILITIES as readonly string[]).includes(value);
}

function publicCredentialRecord(record: CredentialRecord): CredentialRecord {
  return Object.freeze({
    credentialId: record.credentialId,
    credentialSalt: record.credentialSalt,
    credentialHash: record.credentialHash,
    hostId: record.hostId,
    deviceId: record.deviceId,
    routeId: record.routeId,
    capabilities: Object.freeze([...record.capabilities]),
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
    ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }),
  });
}

function parseCredential(credential: string): { credentialId: string } | undefined {
  if (typeof credential !== "string"
    || credential.length > REMOTE_CONTROL_LIMITS.maxCredentialChars) return undefined;
  const match = /^chili_rc1_([A-Za-z0-9_-]{22})_([A-Za-z0-9_-]{43})$/.exec(credential);
  const credentialId = match?.[1];
  if (!credentialId) return undefined;
  return { credentialId };
}

function credentialDigestMatches(record: CredentialRecord, credential: string): boolean {
  try {
    const actual = Buffer.from(hashCredential(credential, record.credentialSalt), "hex");
    const expected = Buffer.from(record.credentialHash, "hex");
    return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function performDummyCredentialComparison(credential: unknown): void {
  const salt = Buffer.alloc(CREDENTIAL_SALT_BYTES, 0xa5);
  const actual = createHash("sha256")
    .update(salt)
    .update(Buffer.from(
      typeof credential === "string"
        ? credential.slice(0, REMOTE_CONTROL_LIMITS.maxCredentialChars)
        : "",
      "utf8",
    ))
    .digest();
  const expected = createHash("sha256").update("invalid-credential-sentinel").digest();
  timingSafeEqual(actual, expected);
}

function parseSealedRelayEnvelope(
  envelope: unknown,
  configuredMaxCiphertextBytes: number | undefined,
): SealedRelayEnvelope {
  if (!isRecord(envelope)
    || envelope.version !== 1
    || typeof envelope.routeId !== "string"
    || typeof envelope.direction !== "string"
    || typeof envelope.messageId !== "string"
    || !(envelope.ciphertext instanceof Uint8Array)
    || !Number.isSafeInteger(envelope.byteLength)
    || !Number.isSafeInteger(envelope.createdAt)) {
    throw new PairingSecurityError("RELAY_ENVELOPE_INVALID");
  }
  assertOpaqueId(envelope.routeId, "RELAY_ENVELOPE_INVALID");
  assertOpaqueId(envelope.messageId, "RELAY_ENVELOPE_INVALID");
  assertRelayDirection(envelope.direction);
  const byteLength = envelope.byteLength as number;
  const createdAt = envelope.createdAt as number;
  const maxCiphertextBytes = positiveSafeInteger(
    configuredMaxCiphertextBytes ?? REMOTE_CONTROL_LIMITS.maxCiphertextBytes,
    "MESSAGE_TOO_LARGE",
  );
  if (byteLength !== envelope.ciphertext.byteLength
    || byteLength < AES_GCM_NONCE_BYTES + AES_GCM_TAG_BYTES
    || createdAt < 0) {
    throw new PairingSecurityError("RELAY_ENVELOPE_INVALID");
  }
  if (byteLength > maxCiphertextBytes) {
    throw new PairingSecurityError("MESSAGE_TOO_LARGE");
  }
  return {
    version: 1,
    routeId: envelope.routeId,
    direction: envelope.direction,
    messageId: envelope.messageId,
    ciphertext: envelope.ciphertext,
    byteLength,
    createdAt,
  };
}

function relayEnvelopeRouteId(envelope: unknown): string {
  if (!isRecord(envelope) || typeof envelope.routeId !== "string") {
    throw new PairingSecurityError("RELAY_ENVELOPE_INVALID");
  }
  assertOpaqueId(envelope.routeId, "RELAY_ENVELOPE_INVALID");
  return envelope.routeId;
}

function relayAad(
  channel: RelayChannelKey,
  envelope: Pick<
    SealedRelayEnvelope,
    "version" | "routeId" | "direction" | "messageId" | "byteLength" | "createdAt"
  >,
): Buffer {
  return Buffer.from(JSON.stringify({
    domain: RELAY_AEAD_DOMAIN,
    hostId: channel.hostId,
    version: envelope.version,
    routeId: envelope.routeId,
    direction: envelope.direction,
    messageId: envelope.messageId,
    byteLength: envelope.byteLength,
    createdAt: envelope.createdAt,
  }), "utf8");
}

function decodeChannelRootKey(channel: RelayChannelKey): Buffer {
  assertHostId(channel.hostId);
  assertOpaqueId(channel.routeId, "ROUTE_MISMATCH");
  const key = decodeCanonicalBase64Url(channel.key, "RELAY_ENVELOPE_INVALID", AES_KEY_BYTES);
  if (key.byteLength !== AES_KEY_BYTES) {
    throw new PairingSecurityError("RELAY_ENVELOPE_INVALID");
  }
  return key;
}

function deriveDirectionalChannelKey(
  channel: RelayChannelKey,
  direction: RelayDirection,
): Buffer {
  assertRelayDirection(direction);
  const rootKey = decodeChannelRootKey(channel);
  const salt = Buffer.from(`${RELAY_AEAD_DOMAIN}\u0000${channel.routeId}`, "utf8");
  const info = Buffer.from(`${channel.hostId}\u0000${direction}`, "utf8");
  return Buffer.from(hkdfSync("sha256", rootKey, salt, info, AES_KEY_BYTES));
}

function replayKey(
  envelope: Pick<SealedRelayEnvelope, "routeId" | "direction" | "messageId">,
): string {
  return `${envelope.routeId}\u0000${envelope.direction}\u0000${envelope.messageId}`;
}

function digestHex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function randomToken(
  label: string,
  size: number,
  randomBytes: RandomBytesSource,
): string {
  return `${label}_${randomBytesExact(size, randomBytes).toString("base64url")}`;
}

function randomBytesExact(size: number, source: RandomBytesSource): Buffer {
  let value: Uint8Array;
  try {
    value = source(size);
  } catch {
    throw new PairingSecurityError("RANDOM_SOURCE_INVALID");
  }
  if (!(value instanceof Uint8Array) || value.byteLength !== size) {
    throw new PairingSecurityError("RANDOM_SOURCE_INVALID");
  }
  return Buffer.from(value);
}

function defaultRandomBytes(size: number): Uint8Array {
  return nodeRandomBytes(size);
}

function decodeCanonicalBase64Url(
  value: string,
  errorCode: PairingSecurityErrorCode,
  maxBytes: number,
): Buffer {
  const maxEncodedCharacters = Math.ceil((maxBytes * 4) / 3);
  if (typeof value !== "string" || value.length === 0
    || value.length > maxEncodedCharacters
    || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new PairingSecurityError(errorCode);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength === 0 || decoded.byteLength > maxBytes
    || decoded.toString("base64url") !== value) {
    throw new PairingSecurityError(errorCode);
  }
  return decoded;
}

function assertDeviceIdShape(deviceId: string): void {
  if (typeof deviceId !== "string"
    || !new RegExp(`^${DEVICE_ID_PREFIX}[A-Za-z0-9_-]{43}$`).test(deviceId)) {
    throw new PairingSecurityError("DEVICE_ID_MISMATCH");
  }
}

function assertHostId(hostId: string): void {
  if (typeof hostId !== "string"
    || hostId.length === 0
    || hostId.length > REMOTE_CONTROL_LIMITS.maxIdentifierChars
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(hostId)) {
    throw new PairingSecurityError("HOST_MISMATCH");
  }
}

function assertOpaqueId(value: string, code: PairingSecurityErrorCode): void {
  if (typeof value !== "string" || value.length < 8 || value.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw new PairingSecurityError(code);
  }
}

function assertRelayDirection(direction: string): asserts direction is RelayDirection {
  if (direction !== "device_to_host" && direction !== "host_to_device") {
    throw new PairingSecurityError("RELAY_ENVELOPE_INVALID");
  }
}

function readClock(clock: Clock): number {
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new PairingSecurityError("CREDENTIAL_INVALID");
  }
  return now;
}

function safeExpiry(
  now: number,
  ttlMs: number,
  code: PairingSecurityErrorCode,
): number {
  const expiresAt = now + ttlMs;
  if (!Number.isSafeInteger(expiresAt)) throw new PairingSecurityError(code);
  return expiresAt;
}

function positiveSafeInteger(
  value: number,
  code: PairingSecurityErrorCode,
): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new PairingSecurityError(code);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
