/** Local renderer management only. None of these operations enter HostBridge. */
export const REMOTE_DESKTOP_CHANNEL = "chili:remote-control:invoke";

export type RemoteDesktopRequest =
  | { type: "status" | "enable" | "disable" | "pairing.create" }
  | { type: "setup.clear" }
  | { type: "setup.save"; bindAddress: string; port: number; tls: "keep" | "select" }
  | { type: "pairing.approve" | "pairing.reject"; pairingId: string }
  | { type: "device.revoke"; deviceId: string };

/** Public setup metadata only. File selections and TLS material stay in main. */
export interface RemoteDesktopSetupState {
  source: "none" | "saved" | "environment";
  addresses: Array<{ address: string; label: string }>;
  bindAddress?: string;
  port: number;
  hasTlsFiles: boolean;
  busy: boolean;
  error?: string;
}

export interface RemoteDesktopState {
  enabled: boolean;
  configured: boolean;
  origin?: string;
  pairing?: { code: string; expiresAt: number };
  pending: Array<{ pairingId: string; deviceId: string; label: string; expiresAt: number }>;
  devices: Array<{ deviceId: string; label: string; expiresAt: number }>;
  setup?: RemoteDesktopSetupState;
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
function port(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new TypeError("Invalid HTTPS port");
  }
  return value;
}

export function parseRemoteDesktopRequest(value: unknown): RemoteDesktopRequest {
  const input = record(value);
  const type = text(input.type);
  const keys = type === "device.revoke" ? ["type", "deviceId"]
    : type === "setup.save" ? ["type", "bindAddress", "port", "tls"]
    : type === "pairing.approve" || type === "pairing.reject" ? ["type", "pairingId"] : ["type"];
  if (Object.keys(input).some((key) => !keys.includes(key))) throw new TypeError("Unexpected remote control field");
  if (type === "status" || type === "enable" || type === "disable" || type === "pairing.create" || type === "setup.clear") return { type };
  if (type === "setup.save") {
    if (input.tls !== "keep" && input.tls !== "select") throw new TypeError("Invalid TLS selection");
    return { type, bindAddress: text(input.bindAddress), port: port(input.port), tls: input.tls };
  }
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
  if (input.setup !== undefined) {
    const setup = record(input.setup);
    if (setup.source !== "none" && setup.source !== "saved" && setup.source !== "environment") throw new TypeError("Invalid setup source");
    if (typeof setup.hasTlsFiles !== "boolean" || typeof setup.busy !== "boolean"
      || !Array.isArray(setup.addresses) || setup.addresses.length > 64) throw new TypeError("Invalid setup state");
    output.setup = {
      source: setup.source,
      port: port(setup.port),
      hasTlsFiles: setup.hasTlsFiles,
      busy: setup.busy,
      addresses: setup.addresses.map((value) => {
        const item = record(value);
        return { address: text(item.address), label: text(item.label) };
      }),
    };
    if (setup.bindAddress !== undefined) output.setup.bindAddress = text(setup.bindAddress);
    if (setup.error !== undefined) output.setup.error = text(setup.error, 512);
  }
  return output;
}
