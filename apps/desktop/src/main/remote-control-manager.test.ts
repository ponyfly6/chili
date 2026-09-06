import { expect, test } from "bun:test";
import type { DesktopState } from "../shared/contracts.js";
import type { RemoteDesktopSetupState } from "../shared/remote-control-contracts.js";
import type { DesktopControlService } from "./control-service.js";
import type { DesktopRemoteHttpsConfig } from "./remote-control-config.js";
import { DesktopRemoteControlManager, type DesktopRemoteSettingsAccess } from "./remote-control-manager.js";

const saveRequest = { type: "setup.save", bindAddress: "127.0.0.1", port: 4743, tls: "select" } as const;
const healthy: DesktopState = { sidecar: { phase: "healthy", attempt: 1 }, queuedBySession: {} };

function fixture(overrides: Partial<DesktopRemoteSettingsAccess> = {}) {
  let invalidations = 0;
  let captures = 0;
  let revocations = 0;
  const setup: RemoteDesktopSetupState = {
    source: "saved", addresses: [{ address: "127.0.0.1", label: "This computer" }],
    bindAddress: "127.0.0.1", port: 4743, hasTlsFiles: true, busy: false,
  };
  const settings: DesktopRemoteSettingsAccess = {
    snapshot: () => ({ ...setup }), save: async () => {}, clear: async () => {},
    invalidatePending: () => { invalidations += 1; },
    configuration: async () => undefined, ...overrides,
  };
  const control = {
    captureRemoteControlScope: () => {
      captures += 1;
      return { workspace: "/workspace", signal: new AbortController().signal };
    },
    revokeRemoteControlScope: () => { revocations += 1; },
  } as unknown as DesktopControlService;
  const manager = new DesktopRemoteControlManager({ controlService: control, settings });
  return { manager, setup, counts: () => ({ invalidations, captures, revocations }) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((success, failure) => { resolve = success; reject = failure; });
  return { promise, resolve, reject };
}

test("saving configuration stays off and cannot overlap native setup or enable", async () => {
  const gate = deferred<void>();
  const entered = deferred<void>();
  const inputs: unknown[] = [];
  const { manager, counts } = fixture({ save: async (input) => { inputs.push(input); entered.resolve(); await gate.promise; } });
  const saving = manager.invoke(saveRequest);
  await entered.promise;
  expect((await manager.invoke({ type: "status" })).setup?.busy).toBe(true);
  await expect(manager.invoke({ type: "enable" })).rejects.toThrow("already in progress");
  await expect(manager.invoke({ type: "setup.clear" })).rejects.toThrow("already in progress");
  gate.resolve();
  const state = await saving;
  expect(inputs).toEqual([{ bindAddress: "127.0.0.1", port: 4743, tls: "select" }]);
  expect(state.enabled).toBe(false);
  expect(state.setup?.busy).toBe(false);
  expect(counts().captures).toBe(0);
});

test("disable cancels native setup immediately but keeps admission closed until its picker settles", async () => {
  const gate = deferred<void>();
  const entered = deferred<void>();
  const { manager, counts } = fixture({ save: async () => { entered.resolve(); await gate.promise; } });
  const saving = manager.invoke(saveRequest);
  await entered.promise;
  const disabled = await manager.invoke({ type: "disable" });
  expect(disabled.enabled).toBe(false);
  expect(disabled.setup?.busy).toBe(true);
  expect(counts().invalidations).toBe(1);
  await expect(manager.invoke(saveRequest)).rejects.toThrow("already in progress");
  gate.reject(new Error("Cancelled native selection"));
  expect((await saving).enabled).toBe(false);
  expect(manager.snapshot().setup?.busy).toBe(false);
  expect(counts().captures).toBe(0);
});

test("late enable validation cannot create a remote scope after disable", async () => {
  const gate = deferred<DesktopRemoteHttpsConfig | undefined>();
  const entered = deferred<void>();
  const { manager, counts } = fixture({ configuration: async () => { entered.resolve(); return gate.promise; } });
  const enabling = manager.invoke({ type: "enable" });
  await entered.promise;
  await expect(manager.invoke({ type: "setup.clear" })).rejects.toThrow("Turn off");
  await manager.disable();
  const material = { certificate: Buffer.from("validated certificate"), privateKey: Buffer.from("validated private key") };
  gate.resolve({ bindAddress: "127.0.0.1", port: 4743, publicOrigin: "https://127.0.0.1:4743",
    tlsCertPath: "/private/certificate.pem", tlsKeyPath: "/private/key.pem", webRoot: "/private/web", tlsMaterial: material });
  expect((await enabling).enabled).toBe(false);
  expect(counts().captures).toBe(0);
  expect(material.certificate.every((byte) => byte === 0)).toBe(true);
  expect(material.privateKey.every((byte) => byte === 0)).toBe(true);
});

test("a sidecar generation change invalidates a pending native selection", async () => {
  const gate = deferred<void>();
  const entered = deferred<void>();
  const { manager, counts } = fixture({ save: async () => { entered.resolve(); await gate.promise; } });
  manager.observeSidecar(healthy, 7);
  const saving = manager.invoke(saveRequest);
  await entered.promise;
  manager.observeSidecar(healthy, 7);
  expect(counts().invalidations).toBe(0);
  manager.observeSidecar(healthy, 8);
  expect(counts().invalidations).toBe(1);
  gate.reject(new Error("Cancelled after workspace replacement"));
  expect((await saving).enabled).toBe(false);
});

test("a sidecar failure invalidates enable while validation is pending", async () => {
  const gate = deferred<DesktopRemoteHttpsConfig | undefined>();
  const entered = deferred<void>();
  const { manager, counts } = fixture({ configuration: async () => { entered.resolve(); return gate.promise; } });
  manager.observeSidecar(healthy, 3);
  const enabling = manager.invoke({ type: "enable" });
  await entered.promise;
  manager.observeSidecar({ ...healthy, sidecar: { phase: "recovering", attempt: 2 } }, 3);
  gate.reject(new Error("Obsolete validation"));
  expect((await enabling).enabled).toBe(false);
  expect(counts().captures).toBe(0);
});

test("a previously invalid file or NIC remains retryable without replacing setup", async () => {
  let attempts = 0;
  const { manager, setup } = fixture({ configuration: async () => { attempts += 1; throw new Error("validation failed"); } });
  setup.error = "Choose an available private address on this computer and a port from 1 to 65535.";
  expect(manager.snapshot().configured).toBe(true);
  await expect(manager.invoke({ type: "enable" })).rejects.toThrow(setup.error);
  await expect(manager.invoke({ type: "enable" })).rejects.toThrow(setup.error);
  expect(attempts).toBe(2);
  expect(manager.snapshot().setup?.busy).toBe(false);
});

test("listener file errors do not expose TLS paths and revoke the failed remote scope", async () => {
  const { manager, counts } = fixture({ configuration: async () => ({
    bindAddress: "127.0.0.1", port: 4743, publicOrigin: "https://127.0.0.1:4743",
    tlsCertPath: "/missing-private-certificate.pem", tlsKeyPath: "/missing-private-key.pem", webRoot: "/private-web",
  }) });
  try {
    await manager.invoke({ type: "enable" });
    throw new Error("Expected enable to fail");
  } catch (error) {
    expect(String(error)).toContain("Cannot start HTTPS");
    expect(String(error)).not.toContain("missing-private");
  }
  expect(counts().captures).toBe(1);
  expect(counts().revocations).toBeGreaterThanOrEqual(1);
  expect(manager.snapshot().enabled).toBe(false);
  expect(manager.snapshot().setup?.busy).toBe(false);
});
