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

test("native setup accepts network choices but no renderer-supplied file capabilities", () => {
  const request = { type: "setup.save", bindAddress: "192.168.1.5", port: 4743, tls: "select" } as const;
  expect(parseRemoteDesktopRequest(request)).toEqual(request);
  expect(parseRemoteDesktopRequest({ type: "setup.clear" })).toEqual({ type: "setup.clear" });
  for (const extra of [
    { certificatePath: "/private/certificate.pem" }, { privateKeyPath: "/private/key.pem" },
    { publicOrigin: "https://example.com" }, { webRoot: "/private" }, { pem: "secret" },
  ]) expect(() => parseRemoteDesktopRequest({ ...request, ...extra })).toThrow();
  for (const value of [0, -1, 65_536, 1.5, "4743", NaN]) {
    expect(() => parseRemoteDesktopRequest({ ...request, port: value })).toThrow();
  }
  expect(() => parseRemoteDesktopRequest({ ...request, tls: "path" })).toThrow();
  expect(() => parseRemoteDesktopRequest({ type: "setup.clear", certificatePath: "/private" })).toThrow();
});

test("setup projection is bounded and excludes certificate and filesystem details", () => {
  const safe = parseRemoteDesktopState({ enabled: false, configured: true, pending: [], devices: [],
    setup: { source: "saved", bindAddress: "192.168.1.5", port: 4743, hasTlsFiles: true, busy: false,
      certificatePath: "/private/secret.pem", privateKey: "secret",
      addresses: [{ address: "192.168.1.5", label: "Wi-Fi", hardwareId: "secret" }] },
  });
  expect(safe.setup?.hasTlsFiles).toBe(true);
  expect(JSON.stringify(safe)).not.toContain("secret");
  expect(JSON.stringify(safe)).not.toContain("/private");
  expect(() => parseRemoteDesktopState({ ...safe, setup: { ...safe.setup, addresses: Array(65).fill(safe.setup!.addresses[0]) } })).toThrow();
  expect(() => parseRemoteDesktopState({ ...safe, setup: { ...safe.setup, source: "phone" } })).toThrow();
});
