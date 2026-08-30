import { expect, test } from "bun:test";
import { parseRemoteDesktopRequest, parseRemoteDesktopState } from "./remote-control-contracts.js";

test("local management parser cannot smuggle paths, permission or remote task operations", () => {
  for (const value of [
    { type: "enable", workspace: "/another/workspace" },
    { type: "enable", tlsKeyPath: "/secret" },
    { type: "permissions.set", profile: "full-access" },
    { type: "sessions.create" },
    { type: "pairing.approve", pairingId: "" },
    { type: "device.revoke", deviceId: "device", credential: "secret" },
  ]) expect(() => parseRemoteDesktopRequest(value)).toThrow();
  expect(parseRemoteDesktopRequest({ type: "pairing.approve", pairingId: "pair_1" })).toEqual({ type: "pairing.approve", pairingId: "pair_1" });
});

test("preload remote management projection never forwards listener or credential internals", () => {
  const safe = parseRemoteDesktopState({
    enabled: true, configured: true, origin: "https://192.168.1.5:7443",
    tlsKey: "secret-key", credential: "secret-credential",
    pending: [{ pairingId: "p", deviceId: "d", label: "Phone", expiresAt: 1, grant: { key: "secret" } }],
    devices: [{ deviceId: "d", label: "Phone", expiresAt: 2, credentialHash: "secret-hash" }],
    pairing: { code: "ONETIME", expiresAt: 3, credential: "secret" },
  });
  expect(JSON.stringify(safe)).not.toContain("secret");
  expect(safe.pairing?.code).toBe("ONETIME");
  expect(() => parseRemoteDesktopState({ ...safe, devices: Array(33).fill(safe.devices[0]) })).toThrow();
});
