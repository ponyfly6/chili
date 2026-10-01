import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  InMemoryCredentialStore,
  InMemoryPairingAuthority,
  PairingSecurityError,
  RelayReplayGuard,
  createPairingProof,
  createRelayChannelKey,
  deriveDeviceId,
  generateDeviceIdentity,
  hashCredential,
  openRelayEnvelope,
  sealRelayEnvelope,
  type PairingSecurityErrorCode,
  type RandomBytesSource,
} from "./pairing-security.js";

function deterministicRandom(seed: string): RandomBytesSource {
  let counter = 0;
  return (size) => {
    const output = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const block = createHash("sha256")
        .update(seed)
        .update(String(counter))
        .digest();
      counter += 1;
      offset += block.copy(output, offset, 0, Math.min(block.length, size - offset));
    }
    return output;
  };
}

function expectSecurityCode(action: () => unknown, code: PairingSecurityErrorCode): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(PairingSecurityError);
  expect((thrown as PairingSecurityError).code).toBe(code);
  expect((thrown as Error).message).toBe(code);
}

function replaceLastCharacter(value: string): string {
  const last = value.at(-1);
  return `${value.slice(0, -1)}${last === "A" ? "B" : "A"}`;
}

describe("device identity and one-time pairing", () => {
  test("binds a device id to its Ed25519 public key and signs the full challenge", () => {
    const identity = generateDeviceIdentity();
    const impostor = generateDeviceIdentity();
    let now = 10_000;
    const authority = new InMemoryPairingAuthority({
      hostId: "host_pairing",
      allowedCapabilities: ["sessions.read", "sessions.send"],
      clock: () => now,
      randomBytes: deterministicRandom("pairing"),
      pairingNonceTtlMs: 1_000,
      credentialTtlMs: 10_000,
    });

    expect(identity.algorithm).toBe("Ed25519");
    expect(deriveDeviceId(identity.publicKey)).toBe(identity.deviceId);
    expectSecurityCode(
      () => authority.beginPairing({
        deviceId: impostor.deviceId,
        publicKey: identity.publicKey,
        grantedCapabilities: ["sessions.read"],
      }),
      "DEVICE_ID_MISMATCH",
    );

    const challenge = authority.beginPairing({
      deviceId: identity.deviceId,
      publicKey: identity.publicKey,
      grantedCapabilities: ["sessions.read"],
    });
    expect(challenge.capabilities).toEqual(["sessions.read"]);
    expect(challenge.expiresAt).toBe(now + 1_000);

    const forgedProof = createPairingProof(challenge, impostor.privateKey);
    expectSecurityCode(() => authority.completePairing(forgedProof), "PAIRING_PROOF_INVALID");

    // A forged proof must not consume the nonce and deny the legitimate device.
    const proof = createPairingProof(challenge, identity.privateKey);
    const grant = authority.completePairing(proof);
    expect(grant.deviceId).toBe(identity.deviceId);
    expect(grant.capabilities).toEqual(["sessions.read"]);
    expect(grant.channel.routeId).toBe(challenge.routeId);
    expect(grant.channel.key).not.toContain(grant.credential);

    expectSecurityCode(() => authority.completePairing(proof), "PAIRING_NONCE_REUSED");
    now += 1;
  });

  test("rejects transcript tampering without consuming the valid challenge", () => {
    const identity = generateDeviceIdentity();
    const authority = new InMemoryPairingAuthority({
      hostId: "host_tamper",
      allowedCapabilities: ["sessions.read", "sessions.send"],
      clock: () => 20_000,
      randomBytes: deterministicRandom("tamper"),
    });
    const challenge = authority.beginPairing({
      deviceId: identity.deviceId,
      publicKey: identity.publicKey,
      grantedCapabilities: ["sessions.read"],
    });
    const wrongHostProof = createPairingProof(
      { ...challenge, hostId: "host_other" },
      identity.privateKey,
    );
    expectSecurityCode(() => authority.completePairing(wrongHostProof), "PAIRING_PROOF_INVALID");
    const tampered = {
      ...challenge,
      capabilities: ["sessions.read", "sessions.send"] as const,
    };
    const forgedProof = createPairingProof(tampered, identity.privateKey);
    expectSecurityCode(() => authority.completePairing(forgedProof), "PAIRING_PROOF_INVALID");
    expect(() => authority.completePairing(createPairingProof(challenge, identity.privateKey)))
      .not.toThrow();
  });

  test("bounds invalid proof attempts without consuming on the first forgery", () => {
    const identity = generateDeviceIdentity();
    const impostor = generateDeviceIdentity();
    const authority = new InMemoryPairingAuthority({
      hostId: "host_attempts",
      allowedCapabilities: ["sessions.read"],
      randomBytes: deterministicRandom("attempts"),
      maxPairingProofAttempts: 2,
    });
    const challenge = authority.beginPairing({
      deviceId: identity.deviceId,
      publicKey: identity.publicKey,
      grantedCapabilities: ["sessions.read"],
    });
    const forged = createPairingProof(challenge, impostor.privateKey);
    expectSecurityCode(() => authority.completePairing(forged), "PAIRING_PROOF_INVALID");
    expectSecurityCode(
      () => authority.completePairing(forged),
      "PAIRING_PROOF_ATTEMPTS_EXCEEDED",
    );
    expectSecurityCode(
      () => authority.completePairing(createPairingProof(challenge, identity.privateKey)),
      "PAIRING_PROOF_ATTEMPTS_EXCEEDED",
    );
  });

  test("rejects oversized key, nonce, and signature presentations before crypto work", () => {
    expectSecurityCode(() => deriveDeviceId("A".repeat(10_000)), "DEVICE_KEY_INVALID");
    const identity = generateDeviceIdentity();
    const authority = new InMemoryPairingAuthority({
      hostId: "host_input_limits",
      allowedCapabilities: ["sessions.read"],
      randomBytes: deterministicRandom("input-limits"),
    });
    const challenge = authority.beginPairing({
      deviceId: identity.deviceId,
      publicKey: identity.publicKey,
      grantedCapabilities: ["sessions.read"],
    });
    expectSecurityCode(
      () => authority.completePairing({
        version: 1,
        nonce: "pair_A".repeat(100_000),
        signature: "A".repeat(86),
      }),
      "PAIRING_NONCE_INVALID",
    );
    expectSecurityCode(
      () => authority.completePairing({
        version: 1,
        nonce: challenge.nonce,
        signature: "A".repeat(100_000),
      }),
      "PAIRING_PROOF_INVALID",
    );
    expect(() => authority.completePairing(createPairingProof(challenge, identity.privateKey)))
      .not.toThrow();
  });

  test("expires nonces and bounds the pending pairing queue", () => {
    const first = generateDeviceIdentity();
    const second = generateDeviceIdentity();
    let now = 30_000;
    const authority = new InMemoryPairingAuthority({
      hostId: "host_bounded",
      allowedCapabilities: ["sessions.read"],
      clock: () => now,
      randomBytes: deterministicRandom("bounded"),
      pairingNonceTtlMs: 100,
      maxPendingPairings: 1,
    });
    const expired = authority.beginPairing({
      deviceId: first.deviceId,
      publicKey: first.publicKey,
      grantedCapabilities: ["sessions.read"],
    });
    expectSecurityCode(
      () => authority.beginPairing({
        deviceId: second.deviceId,
        publicKey: second.publicKey,
        grantedCapabilities: ["sessions.read"],
      }),
      "PAIRING_LIMIT_EXCEEDED",
    );
    now = expired.expiresAt;
    expectSecurityCode(
      () => authority.completePairing(createPairingProof(expired, first.privateKey)),
      "PAIRING_NONCE_EXPIRED",
    );
    expect(() => authority.beginPairing({
      deviceId: second.deviceId,
      publicKey: second.publicKey,
      grantedCapabilities: ["sessions.read"],
    })).not.toThrow();
  });

  test("issues only the exact host-granted subset of host-allowed capabilities", () => {
    const identity = generateDeviceIdentity();
    const authority = new InMemoryPairingAuthority({
      hostId: "host_scope",
      allowedCapabilities: ["sessions.read", "sessions.send"],
      randomBytes: deterministicRandom("scope"),
    });
    const challenge = authority.beginPairing({
      deviceId: identity.deviceId,
      publicKey: identity.publicKey,
      grantedCapabilities: ["sessions.read"],
    });
    const grant = authority.completePairing(createPairingProof(challenge, identity.privateKey));
    expect(grant.capabilities).toEqual(["sessions.read"]);

    expectSecurityCode(
      () => authority.beginPairing({
        deviceId: identity.deviceId,
        publicKey: identity.publicKey,
        grantedCapabilities: ["sessions.stop"],
      }),
      "CAPABILITY_NOT_ALLOWED",
    );
    expectSecurityCode(
      () => authority.beginPairing({
        deviceId: identity.deviceId,
        publicKey: identity.publicKey,
        grantedCapabilities: ["sessions.read", "sessions.read"],
      }),
      "CAPABILITY_NOT_ALLOWED",
    );
  });

  test("bounds active channel records", () => {
    const first = generateDeviceIdentity();
    const second = generateDeviceIdentity();
    const authority = new InMemoryPairingAuthority({
      hostId: "host_channel_limit",
      allowedCapabilities: ["sessions.read"],
      randomBytes: deterministicRandom("channel-limit"),
      maxActiveChannels: 1,
    });
    const firstChallenge = authority.beginPairing({
      deviceId: first.deviceId,
      publicKey: first.publicKey,
      grantedCapabilities: ["sessions.read"],
    });
    const secondChallenge = authority.beginPairing({
      deviceId: second.deviceId,
      publicKey: second.publicKey,
      grantedCapabilities: ["sessions.read"],
    });
    authority.completePairing(createPairingProof(firstChallenge, first.privateKey));
    expectSecurityCode(
      () => authority.completePairing(createPairingProof(secondChallenge, second.privateKey)),
      "CHANNEL_LIMIT_EXCEEDED",
    );
  });
});

describe("hashed, scoped, bound credentials", () => {
  test("stores only a salted digest and validates device, route, and capability", () => {
    const identity = generateDeviceIdentity();
    const routeId = "route_test-credential";
    const store = new InMemoryCredentialStore({
      clock: () => 40_000,
      randomBytes: deterministicRandom("credential"),
      defaultTtlMs: 5_000,
    });
    const issued = store.issue({
      hostId: "host_credentials",
      deviceId: identity.deviceId,
      routeId,
      capabilities: ["sessions.read"],
    });
    const [record] = store.snapshot();
    expect(record).toBeDefined();
    expect(record?.credentialHash).toBe(hashCredential(
      issued.credential,
      issued.record.credentialSalt,
    ));
    expect(record?.credentialHash).toMatch(/^[a-f0-9]{64}$/);
    expect(record?.credentialSalt).not.toBe("");
    expect(issued.credential).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.stringify(store.snapshot())).not.toContain(issued.credential);
    expect(JSON.stringify(store.snapshot())).not.toContain(issued.credential.slice(-43));

    const authorization = store.authenticate({
      credential: issued.credential,
      hostId: "host_credentials",
      deviceId: identity.deviceId,
      routeId,
      capability: "sessions.read",
    });
    expect(authorization.credentialHash).toBe(record!.credentialHash);
    expect(authorization.capabilities).toEqual(["sessions.read"]);

    const forged = replaceLastCharacter(issued.credential);
    expectSecurityCode(
      () => store.authenticate({
        credential: forged,
        hostId: "host_credentials",
        deviceId: identity.deviceId,
        routeId,
        capability: "sessions.read",
      }),
      "CREDENTIAL_INVALID",
    );
    expectSecurityCode(
      () => store.authenticate({
        credential: issued.credential,
        hostId: "host_other",
        deviceId: identity.deviceId,
        routeId,
        capability: "sessions.read",
      }),
      "HOST_MISMATCH",
    );
    expectSecurityCode(
      () => store.authenticate({
        credential: issued.credential,
        hostId: "host_credentials",
        deviceId: generateDeviceIdentity().deviceId,
        routeId,
        capability: "sessions.read",
      }),
      "DEVICE_MISMATCH",
    );
    expectSecurityCode(
      () => store.authenticate({
        credential: issued.credential,
        hostId: "host_credentials",
        deviceId: identity.deviceId,
        routeId: "route_other-channel",
        capability: "sessions.read",
      }),
      "ROUTE_MISMATCH",
    );
    expectSecurityCode(
      () => store.authenticate({
        credential: issued.credential,
        hostId: "host_credentials",
        deviceId: identity.deviceId,
        routeId,
        capability: "sessions.stop",
      }),
      "CAPABILITY_DENIED",
    );
  });

  test("checks expiry and revocation on every request", () => {
    const identity = generateDeviceIdentity();
    let now = 50_000;
    const store = new InMemoryCredentialStore({
      clock: () => now,
      randomBytes: deterministicRandom("lifecycle"),
      defaultTtlMs: 100,
    });
    const expired = store.issue({
      hostId: "host_lifecycle",
      deviceId: identity.deviceId,
      routeId: "route_expiring",
      capabilities: ["sessions.read"],
    });
    now = expired.record.expiresAt;
    expectSecurityCode(
      () => store.authenticate({
        credential: expired.credential,
        hostId: "host_lifecycle",
        deviceId: identity.deviceId,
        routeId: expired.record.routeId,
        capability: "sessions.read",
      }),
      "CREDENTIAL_EXPIRED",
    );

    now += 1;
    const revoked = store.issue({
      hostId: "host_lifecycle",
      deviceId: identity.deviceId,
      routeId: "route_revoked",
      capabilities: ["sessions.read"],
      ttlMs: 1_000,
    });
    expect(store.revokeCredential(revoked.credential)).toBe(true);
    expectSecurityCode(
      () => store.authenticate({
        credential: revoked.credential,
        hostId: "host_lifecycle",
        deviceId: identity.deviceId,
        routeId: revoked.record.routeId,
        capability: "sessions.read",
      }),
      "CREDENTIAL_REVOKED",
    );
    expect(store.revokeCredential(replaceLastCharacter(revoked.credential))).toBe(false);
    expect(store.snapshot().find((record) => record.credentialHash === revoked.record.credentialHash)?.revokedAt)
      .toBe(now);
  });

  test("supports host-admin hash revocation and device-wide revocation", () => {
    const identity = generateDeviceIdentity();
    const other = generateDeviceIdentity();
    const store = new InMemoryCredentialStore({
      clock: () => 60_000,
      randomBytes: deterministicRandom("admin-revoke"),
    });
    const first = store.issue({
      hostId: "host_admin",
      deviceId: identity.deviceId,
      routeId: "route_admin-one",
      capabilities: ["sessions.read"],
    });
    store.issue({
      hostId: "host_admin",
      deviceId: identity.deviceId,
      routeId: "route_admin-two",
      capabilities: ["sessions.send"],
    });
    store.issue({
      hostId: "host_admin",
      deviceId: other.deviceId,
      routeId: "route_other-device",
      capabilities: ["sessions.read"],
    });
    expect(store.revokeCredentialHash(first.record.credentialHash)).toBe(true);
    expect(store.revokeCredentialHash("0".repeat(64))).toBe(false);
    expect(store.revokeDevice(identity.deviceId)).toBe(1);
    expect(store.snapshot().filter((record) => record.revokedAt !== undefined)).toHaveLength(2);
  });

  test("bounds credential records and rejects oversized forged bearers", () => {
    const identity = generateDeviceIdentity();
    const store = new InMemoryCredentialStore({
      clock: () => 65_000,
      randomBytes: deterministicRandom("record-limit"),
      maxRecords: 1,
    });
    const issued = store.issue({
      hostId: "host_record_limit",
      deviceId: identity.deviceId,
      routeId: "route_record-one",
      capabilities: ["sessions.read"],
    });
    expectSecurityCode(
      () => store.issue({
        hostId: "host_record_limit",
        deviceId: identity.deviceId,
        routeId: "route_record-two",
        capabilities: ["sessions.read"],
      }),
      "CREDENTIAL_LIMIT_EXCEEDED",
    );
    expectSecurityCode(
      () => store.authenticate({
        credential: "A".repeat(1_000_000),
        hostId: "host_record_limit",
        deviceId: identity.deviceId,
        routeId: issued.record.routeId,
        capability: "sessions.read",
      }),
      "CREDENTIAL_INVALID",
    );
  });
});

describe("relay-blind authenticated encryption", () => {
  test("keeps credentials, device identity, and payload out of the relay envelope", () => {
    const identity = generateDeviceIdentity();
    const channel = createRelayChannelKey({
      hostId: "host_private",
      routeId: "route_private-channel",
      randomBytes: deterministicRandom("channel"),
    });
    const inner = {
      version: 1,
      deviceId: identity.deviceId,
      credential: "credential-must-never-reach-relay",
      sequence: 1,
      payload: { text: "secret prompt payload" },
    };
    const envelope = sealRelayEnvelope(channel, "device_to_host", inner, {
      clock: () => 70_000,
      randomBytes: deterministicRandom("envelope"),
    });

    expect(envelope).toMatchObject({
      version: 1,
      routeId: channel.routeId,
      direction: "device_to_host",
      byteLength: envelope.ciphertext.byteLength,
      createdAt: 70_000,
    });
    expect(Object.keys(envelope).sort()).toEqual([
      "byteLength",
      "ciphertext",
      "createdAt",
      "direction",
      "messageId",
      "routeId",
      "version",
    ]);
    const relayView = JSON.stringify(envelope);
    const rawCiphertext = Buffer.from(envelope.ciphertext).toString("utf8");
    for (const secret of [inner.credential, inner.deviceId, inner.payload.text]) {
      expect(relayView).not.toContain(secret);
      expect(rawCiphertext).not.toContain(secret);
    }
    expect(openRelayEnvelope<typeof inner>(channel, envelope, { expectedDirection: "device_to_host" }))
      .toEqual(inner);
  });

  test("rejects wrong keys, tampering, direction confusion, and replay", () => {
    const channel = createRelayChannelKey({
      hostId: "host_authenticated",
      routeId: "route_authenticated",
      randomBytes: deterministicRandom("right-key"),
    });
    const wrongKey = createRelayChannelKey({
      hostId: "host_authenticated",
      routeId: channel.routeId,
      randomBytes: deterministicRandom("wrong-key"),
    });
    const envelope = sealRelayEnvelope(channel, "device_to_host", { sequence: 1 }, {
      clock: () => 80_000,
      randomBytes: deterministicRandom("auth-envelope"),
    });
    expectSecurityCode(
      () => openRelayEnvelope(wrongKey, envelope),
      "RELAY_DECRYPTION_FAILED",
    );

    const tamperedBytes = Uint8Array.from(envelope.ciphertext);
    tamperedBytes[12] = (tamperedBytes[12] ?? 0) ^ 1;
    expectSecurityCode(
      () => openRelayEnvelope(channel, { ...envelope, ciphertext: tamperedBytes }),
      "RELAY_DECRYPTION_FAILED",
    );
    expectSecurityCode(
      () => openRelayEnvelope(channel, { ...envelope, messageId: "message_tampered" }),
      "RELAY_DECRYPTION_FAILED",
    );
    expectSecurityCode(
      () => openRelayEnvelope(channel, { ...envelope, direction: "host_to_device" }),
      "RELAY_DECRYPTION_FAILED",
    );
    expectSecurityCode(
      () => openRelayEnvelope({ ...channel, hostId: "host_other" }, envelope),
      "RELAY_DECRYPTION_FAILED",
    );
    expectSecurityCode(
      () => openRelayEnvelope(channel, envelope, { expectedDirection: "host_to_device" }),
      "RELAY_ENVELOPE_INVALID",
    );

    const replayGuard = new RelayReplayGuard();
    expect(openRelayEnvelope<{ sequence: number }>(channel, envelope, { replayGuard }))
      .toEqual({ sequence: 1 });
    expectSecurityCode(
      () => openRelayEnvelope(channel, envelope, { replayGuard }),
      "RELAY_REPLAYED",
    );
  });

  test("rejects oversized plaintext/ciphertext and bounds replay state", () => {
    const channel = createRelayChannelKey({
      hostId: "host_limits",
      routeId: "route_limits",
      randomBytes: deterministicRandom("limits-key"),
    });
    expectSecurityCode(
      () => sealRelayEnvelope(channel, "device_to_host", { text: "x".repeat(100) }, {
        randomBytes: deterministicRandom("too-large"),
        maxPlaintextBytes: 32,
      }),
      "MESSAGE_TOO_LARGE",
    );
    const envelope = sealRelayEnvelope(channel, "device_to_host", { ok: true }, {
      randomBytes: deterministicRandom("within-limit"),
    });
    expectSecurityCode(
      () => openRelayEnvelope(channel, envelope, {
        maxCiphertextBytes: envelope.byteLength - 1,
      }),
      "MESSAGE_TOO_LARGE",
    );
    expectSecurityCode(
      () => openRelayEnvelope(channel, { ...envelope, byteLength: envelope.byteLength + 1 }),
      "RELAY_ENVELOPE_INVALID",
    );

    const guard = new RelayReplayGuard(1);
    guard.record(envelope);
    expectSecurityCode(
      () => guard.record({ ...envelope, messageId: "message_second-entry" }),
      "RELAY_REPLAY_WINDOW_EXHAUSTED",
    );
  });

  test("runs the paired device-to-host encrypted admission path", () => {
    const identity = generateDeviceIdentity();
    const authority = new InMemoryPairingAuthority({
      hostId: "host_vertical",
      allowedCapabilities: ["sessions.read"],
      clock: () => 90_000,
      randomBytes: deterministicRandom("vertical"),
    });
    const challenge = authority.beginPairing({
      deviceId: identity.deviceId,
      publicKey: identity.publicKey,
      grantedCapabilities: ["sessions.read"],
    });
    const grant = authority.completePairing(createPairingProof(challenge, identity.privateKey));
    const inner = {
      deviceId: identity.deviceId,
      credential: grant.credential,
      capability: "sessions.read" as const,
      payload: { operation: "sessions.list" },
    };
    const envelope = sealRelayEnvelope(grant.channel, "device_to_host", inner, {
      clock: () => 90_001,
      randomBytes: deterministicRandom("vertical-envelope"),
    });
    const opened = authority.openRelayEnvelope<typeof inner>(envelope, {
      expectedDirection: "device_to_host",
      replayGuard: new RelayReplayGuard(),
    });
    const authorization = authority.authenticate({
      credential: opened.credential,
      hostId: grant.hostId,
      deviceId: opened.deviceId,
      routeId: envelope.routeId,
      capability: opened.capability,
    });
    expect(authorization.deviceId).toBe(identity.deviceId);
    expect(authorization.routeId).toBe(grant.channel.routeId);
  });
});
