import type { PairingChallenge, RelayChannelKey, SealedRelayEnvelope } from "./pairing-security.js";
import type { RemoteControlRelayDirection } from "./protocol.js";

/** Wire-level cryptographic domains shared by Node and browser implementations. */
export const RELAY_AEAD_DOMAIN = "chili.remote-control.relay-aead.v1";
const encoder = new TextEncoder();

export function pairingProofBytes(challenge: PairingChallenge): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify({
    domain: "chili.remote-control.pairing-proof.v1",
    version: challenge.version,
    hostId: challenge.hostId,
    deviceId: challenge.deviceId,
    publicKey: challenge.publicKey,
    routeId: challenge.routeId,
    nonce: challenge.nonce,
    capabilities: [...challenge.capabilities],
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
  }));
}

export function relayAadBytes(
  channel: RelayChannelKey,
  envelope: Pick<SealedRelayEnvelope, "version" | "routeId" | "direction" | "messageId" | "byteLength" | "createdAt">,
): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify({
    domain: RELAY_AEAD_DOMAIN,
    hostId: channel.hostId,
    version: envelope.version,
    routeId: envelope.routeId,
    direction: envelope.direction,
    messageId: envelope.messageId,
    byteLength: envelope.byteLength,
    createdAt: envelope.createdAt,
  }));
}

export function relayKeyDerivationBytes(channel: RelayChannelKey, direction: RemoteControlRelayDirection): {
  salt: Uint8Array<ArrayBuffer>;
  info: Uint8Array<ArrayBuffer>;
} {
  return {
    salt: encoder.encode(`${RELAY_AEAD_DOMAIN}\u0000${channel.routeId}`),
    info: encoder.encode(`${channel.hostId}\u0000${direction}`),
  };
}
