/** Local renderer management only. None of these operations enter HostBridge. */
export const REMOTE_DESKTOP_CHANNEL = "chili:remote-control:invoke";

export type RemoteDesktopRequest =
  | { type: "status" | "enable" | "disable" | "pairing.create" }
  | { type: "pairing.approve" | "pairing.reject"; pairingId: string }
  | { type: "device.revoke"; deviceId: string };

export interface RemoteDesktopState {
  enabled: boolean;
  configured: boolean;
  origin?: string;
  pairing?: { code: string; expiresAt: number };
  pending: Array<{ pairingId: string; deviceId: string; label: string; expiresAt: number }>;
  devices: Array<{ deviceId: string; label: string; expiresAt: number }>;
}

export interface ChiliRemoteDesktopApi {
  invoke(request: RemoteDesktopRequest): Promise<RemoteDesktopState>;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid remote control data");
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 128): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new TypeError("Invalid remote control field");
  return value;
}
function expiry(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError("Invalid expiry");
  return value;
}

export function parseRemoteDesktopRequest(value: unknown): RemoteDesktopRequest {
  const input = record(value);
  const type = text(input.type);
  const keys = type === "device.revoke" ? ["type", "deviceId"]
    : type === "pairing.approve" || type === "pairing.reject" ? ["type", "pairingId"] : ["type"];
  if (Object.keys(input).some((key) => !keys.includes(key))) throw new TypeError("Unexpected remote control field");
  if (type === "status" || type === "enable" || type === "disable" || type === "pairing.create") return { type };
  if (type === "pairing.approve" || type === "pairing.reject") return { type, pairingId: text(input.pairingId) };
  if (type === "device.revoke") return { type, deviceId: text(input.deviceId) };
  throw new TypeError("Unsupported remote management operation");
}

/** Copy a bounded allowlist across the preload boundary, never host secrets. */
export function parseRemoteDesktopState(value: unknown): RemoteDesktopState {
  const input = record(value);
  if (typeof input.enabled !== "boolean" || typeof input.configured !== "boolean") throw new TypeError("Invalid remote state");
  if (!Array.isArray(input.pending) || input.pending.length > 32 || !Array.isArray(input.devices) || input.devices.length > 32) {
    throw new TypeError("Invalid remote device list");
  }
  const output: RemoteDesktopState = {
    enabled: input.enabled,
    configured: input.configured,
    pending: input.pending.map((item) => {
      const row = record(item);
      return { pairingId: text(row.pairingId), deviceId: text(row.deviceId), label: text(row.label), expiresAt: expiry(row.expiresAt) };
    }),
    devices: input.devices.map((item) => {
      const row = record(item);
      return { deviceId: text(row.deviceId), label: text(row.label), expiresAt: expiry(row.expiresAt) };
    }),
  };
  if (input.origin !== undefined) output.origin = text(input.origin, 512);
  if (input.pairing !== undefined) {
    const pair = record(input.pairing);
    output.pairing = { code: text(pair.code), expiresAt: expiry(pair.expiresAt) };
  }
  return output;
}
