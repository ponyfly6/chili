import { REMOTE_CONTROL_LIMITS, parseOpaqueRelayEnvelope, type OpaqueRelayEnvelope } from "./protocol.js";

/** JSON transport only. Ciphertext is canonical unpadded base64url, never plaintext. */
export interface WireRelayEnvelope {
  version: 1;
  routeId: string;
  direction: "device_to_host" | "host_to_device";
  messageId: string;
  ciphertext: string;
  byteLength: number;
  createdAt: number;
}

export const MAX_HTTP_RESPONSE_BYTES = 1_048_576;

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeBase64Url(value: unknown, maxBytes: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || value.length === 0
    || value.length > Math.ceil(maxBytes * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError("INVALID_BASE64URL");
  }
  let binary: string;
  try {
    binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  } catch {
    throw new TypeError("INVALID_BASE64URL");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.byteLength > maxBytes || encodeBase64Url(bytes) !== value) {
    throw new TypeError("INVALID_BASE64URL");
  }
  return bytes;
}

export function encodeWireEnvelope(envelope: OpaqueRelayEnvelope): WireRelayEnvelope {
  const parsed = parseOpaqueRelayEnvelope(envelope);
  return { ...parsed, ciphertext: encodeBase64Url(parsed.ciphertext) };
}

export function decodeWireEnvelope(value: unknown): OpaqueRelayEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("INVALID_WIRE_ENVELOPE");
  }
  const record = value as Record<string, unknown>;
  return parseOpaqueRelayEnvelope({
    ...record,
    ciphertext: decodeBase64Url(record.ciphertext, REMOTE_CONTROL_LIMITS.maxCiphertextBytes),
  });
}
