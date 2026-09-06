import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disposePrivateControlTlsMaterial, PrivateControlHttpsHost } from "@chili/remote-control";
import { DesktopRemoteSettings } from "./remote-control-settings.js";

let certificateDirectory: string;
let certificatePath: string;
let privateKeyPath: string;
let otherPrivateKeyPath: string;
let commonNameOnlyCertificatePath: string;
let certificate: X509Certificate;
const temporaryDirectories: string[] = [];

beforeAll(async () => {
  certificateDirectory = await mkdtemp(join(tmpdir(), "chili-remote-settings-cert-"));
  certificatePath = join(certificateDirectory, "certificate.pem");
  privateKeyPath = join(certificateDirectory, "private-key.pem");
  otherPrivateKeyPath = join(certificateDirectory, "other-private-key.pem");
  commonNameOnlyCertificatePath = join(certificateDirectory, "common-name-only.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", privateKeyPath,
    "-out", certificatePath, "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ], { stdio: "ignore" });
  execFileSync("openssl", ["genrsa", "-out", otherPrivateKeyPath, "2048"], { stdio: "ignore" });
  execFileSync("openssl", [
    "req", "-x509", "-key", privateKeyPath, "-out", commonNameOnlyCertificatePath,
    "-days", "1", "-subj", "/CN=localhost",
  ], { stdio: "ignore" });
  certificate = new X509Certificate(await readFile(certificatePath));
  expect(new X509Certificate(await readFile(commonNameOnlyCertificatePath)).subjectAltName).toBeUndefined();
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await chmod(directory, 0o700).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }));
});

afterAll(async () => {
  await rm(certificateDirectory, { recursive: true, force: true });
});

describe("desktop remote settings", () => {
  test("starts unconfigured and exposes only a public setup projection", async () => {
    const fixture = await settingsFixture();
    expect(fixture.settings.snapshot()).toMatchObject({ source: "none", port: 4743, hasTlsFiles: false, busy: false });
    expect(await fixture.settings.configuration()).toBeUndefined();
    expect(await readdir(fixture.directory)).toEqual([]);
    assertPublicSnapshot(fixture.settings, fixture.directory);
  });

  test("offers usable private interfaces first, deduplicates them and conceals hardware labels", async () => {
    const fixture = await settingsFixture({ networkAddresses: () => [
      { address: "127.0.0.1", label: "SECRET-HARDWARE-loopback" },
      { address: "fd12:3456::1", label: "SECRET-HARDWARE-IPv6" },
      { address: "8.8.8.8", label: "SECRET-HARDWARE-public" },
      { address: "fe80::1", label: "SECRET-HARDWARE-link-local" },
      { address: "fe80::2%en0", label: "SECRET-HARDWARE-scoped" },
      { address: "192.168.1.10", label: "SECRET-HARDWARE-WiFi" },
      { address: "192.168.1.10", label: "SECRET-HARDWARE-duplicate" },
      { address: "0.0.0.0", label: "SECRET-HARDWARE-wildcard" },
    ] });
    const snapshot = fixture.settings.snapshot();
    expect(snapshot.addresses.map(({ address }) => address)).toEqual(["192.168.1.10", "fd12:3456::1", "127.0.0.1"]);
    expect(snapshot.bindAddress).toBe("192.168.1.10");
    expect(snapshot.addresses.every(({ label }) => label.length > 0)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("SECRET-HARDWARE");
  });

  test("invalid launch addresses never echo arbitrary launch text into the renderer projection", async () => {
    for (const bindAddress of ["/private/fixture-path-canary", "token-canary", "x".repeat(200), "8.8.8.8"]) {
      const fixture = await settingsFixture({ environment: {
        CHILI_REMOTE_BIND_ADDRESS: bindAddress, CHILI_REMOTE_PORT: "4743",
        CHILI_REMOTE_ORIGIN: "https://127.0.0.1:4743",
        CHILI_REMOTE_TLS_CERT: certificatePath, CHILI_REMOTE_TLS_KEY: privateKeyPath,
      } });
      const snapshot = fixture.settings.snapshot();
      expect(snapshot.source).toBe("environment");
      expect(snapshot.error).toBeDefined();
      expect(snapshot.bindAddress).toBeUndefined();
      expect(JSON.stringify(snapshot)).not.toContain(bindAddress);
    }
  });

  test("canceling native TLS selection leaves both old configuration and disk untouched", async () => {
    let selected = true;
    const fixture = await settingsFixture({ chooseTlsFiles: async () => selected ? tlsSelection() : undefined });
    await fixture.settings.save(saveInput());
    const before = await readFile(fixture.settingsPath, "utf8");
    selected = false;
    await fixture.settings.save(saveInput({ port: 4744 }));
    expect(await readFile(fixture.settingsPath, "utf8")).toBe(before);
    expect(fixture.settings.snapshot()).toMatchObject({ source: "saved", port: 4743, busy: false });

    const empty = await settingsFixture({ chooseTlsFiles: async () => undefined });
    await empty.settings.save(saveInput());
    expect(empty.settings.snapshot()).toMatchObject({ source: "none", hasTlsFiles: false, busy: false });
    expect(await readdir(empty.directory)).toEqual([]);
  });

  test("persists only configuration at mode 0600 and restores without credentials or enabled state", async () => {
    const fixture = await settingsFixture();
    await fixture.settings.save(saveInput());
    const persisted = JSON.parse(await readFile(fixture.settingsPath, "utf8")) as Record<string, unknown>;
    expect(persisted).toEqual({
      version: 1, bindAddress: "127.0.0.1", port: 4743,
      tlsCertPath: certificatePath, tlsKeyPath: privateKeyPath,
    });
    expect((await stat(fixture.settingsPath)).mode & 0o777).toBe(0o600);
    const restored = new DesktopRemoteSettings(fixture.options);
    await restored.initialize();
    expect(restored.snapshot()).toMatchObject({ source: "saved", bindAddress: "127.0.0.1", port: 4743, hasTlsFiles: true, busy: false });
    expect(await configurationFields(restored)).toEqual({
      bindAddress: "127.0.0.1", port: 4743, publicOrigin: "https://127.0.0.1:4743",
      tlsCertPath: certificatePath, tlsKeyPath: privateKeyPath, webRoot: fixture.directory,
    });
    assertPublicSnapshot(restored, fixture.directory);
  });

  test("keep reuses main-owned TLS paths and clear removes saved configuration", async () => {
    let selections = 0;
    const fixture = await settingsFixture({ chooseTlsFiles: async () => { selections += 1; return tlsSelection(); } });
    await rejectedWithoutSecrets(fixture.settings.save(saveInput({ tls: "keep" })));
    await fixture.settings.save(saveInput());
    await fixture.settings.save(saveInput({ tls: "keep", port: 4744 }));
    expect(selections).toBe(1);
    expect((await configurationFields(fixture.settings))?.publicOrigin).toBe("https://127.0.0.1:4744");
    await fixture.settings.clear();
    expect(fixture.settings.snapshot()).toMatchObject({ source: "none", hasTlsFiles: false, busy: false });
    expect(await fixture.settings.configuration()).toBeUndefined();
    expect(await readdir(fixture.directory)).toEqual([]);
    const restored = new DesktopRemoteSettings(fixture.options);
    await restored.initialize();
    expect(restored.snapshot().source).toBe("none");
  });

  test("complete environment configuration takes precedence and cannot be saved or cleared", async () => {
    const fixture = await settingsFixture();
    await fixture.settings.save(saveInput());
    const saved = await readFile(fixture.settingsPath, "utf8");
    let selections = 0;
    const environment = environmentConfig({ CHILI_REMOTE_PORT: "5743", CHILI_REMOTE_ORIGIN: "https://127.0.0.1:5743" });
    const settings = new DesktopRemoteSettings({ ...fixture.options, environment,
      chooseTlsFiles: async () => { selections += 1; return tlsSelection(); } });
    await settings.initialize();
    expect(settings.snapshot()).toMatchObject({ source: "environment", port: 5743, hasTlsFiles: true, busy: false });
    expect((await configurationFields(settings))?.port).toBe(5743);
    await rejectedWithoutSecrets(settings.save(saveInput()));
    await rejectedWithoutSecrets(settings.clear());
    expect(selections).toBe(0);
    expect(await readFile(fixture.settingsPath, "utf8")).toBe(saved);
    assertPublicSnapshot(settings, fixture.directory);
  });

  test("accepts a private environment hostname covered by a DNS SAN", async () => {
    const fixture = await settingsFixture({ environment: environmentConfig({ CHILI_REMOTE_ORIGIN: "https://localhost:4743" }) });
    expect(fixture.settings.snapshot()).toMatchObject({ source: "environment", hasTlsFiles: true });
    expect(fixture.settings.snapshot().error).toBeUndefined();
    expect((await configurationFields(fixture.settings))?.publicOrigin).toBe("https://localhost:4743");
    assertPublicSnapshot(fixture.settings, fixture.directory);
  });

  test("a matching common name without a DNS SAN cannot enable environment configuration", async () => {
    const fixture = await settingsFixture({ environment: environmentConfig({
      CHILI_REMOTE_ORIGIN: "https://localhost:4743", CHILI_REMOTE_TLS_CERT: commonNameOnlyCertificatePath,
    }) });
    expect(fixture.settings.snapshot().error).toBeUndefined();
    await rejectedWithoutSecrets(fixture.settings.configuration());
    expect(fixture.settings.snapshot().error).toBeTruthy();
    assertPublicSnapshot(fixture.settings, fixture.directory);
  });

  test.each(["unresolved DNS", "missing TLS files"] as const)("loads disabled launch references without %s verification during desktop boot", async (unavailable) => {
    const fixture = await settingsFixture({ environment: environmentConfig({
      CHILI_REMOTE_ORIGIN: unavailable === "unresolved DNS" ? "https://pending-phone.invalid:4743" : "https://127.0.0.1:4743",
      CHILI_REMOTE_TLS_CERT: "/missing-phone-certificate.pem",
      CHILI_REMOTE_TLS_KEY: "/missing-phone-private-key.pem",
    }) });
    expect(fixture.settings.snapshot()).toMatchObject({ source: "environment", hasTlsFiles: true, busy: false });
    expect(fixture.settings.snapshot().error).toBeUndefined();
    await rejectedWithoutSecrets(fixture.settings.configuration());
    expect(fixture.settings.snapshot().error).toBeTruthy();
    assertPublicSnapshot(fixture.settings, fixture.directory);
  });

  test.each(["CHILI_REMOTE_BIND_ADDRESS", "CHILI_REMOTE_WEB_ROOT"])(
    "partial environment configuration (%s) fails closed instead of mixing saved values", async (field) => {
      const fixture = await settingsFixture();
      await fixture.settings.save(saveInput());
      const saved = await readFile(fixture.settingsPath, "utf8");
      const settings = new DesktopRemoteSettings({ ...fixture.options,
        environment: { [field]: field === "CHILI_REMOTE_BIND_ADDRESS" ? "127.0.0.1" : fixture.directory } });
      await settings.initialize();
      expect(settings.snapshot()).toMatchObject({ source: "environment", hasTlsFiles: false, busy: false });
      expect(settings.snapshot().error).toBeTruthy();
      await rejectedWithoutSecrets(settings.configuration(), [fixture.directory]);
      await rejectedWithoutSecrets(settings.save(saveInput()), [fixture.directory]);
      await rejectedWithoutSecrets(settings.clear(), [fixture.directory]);
      expect(await readFile(fixture.settingsPath, "utf8")).toBe(saved);
      assertPublicSnapshot(settings, fixture.directory);
    },
  );

  test.each(["CHILI_REMOTE_BIND_ADDRESS", "CHILI_REMOTE_WEB_ROOT"])(
    "an empty %s environment field fails closed", async (field) => {
      const fixture = await settingsFixture({ environment: { [field]: "" } });
      expect(fixture.settings.snapshot()).toMatchObject({ source: "environment", hasTlsFiles: false });
      expect(fixture.settings.snapshot().error).toBeTruthy();
      await rejectedWithoutSecrets(fixture.settings.configuration());
      await rejectedWithoutSecrets(fixture.settings.save(saveInput()));
      await rejectedWithoutSecrets(fixture.settings.clear());
      expect(await readdir(fixture.directory)).toEqual([]);
    },
  );

  test.each(["8.8.8.8", "0.0.0.0", "::", "127.0.0.2", "localhost"])(
    "rejects public, wildcard, nonlocal or nonliteral bind address %s", async (bindAddress) => {
      const fixture = await settingsFixture();
      await rejectedWithoutSecrets(fixture.settings.save(saveInput({ bindAddress })));
      expect(fixture.settings.snapshot().source).toBe("none");
      expect(await readdir(fixture.directory)).toEqual([]);
    },
  );

  for (const port of [0, -1, 65536, 4743.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    test(`rejects invalid port ${port}`, async () => {
      const fixture = await settingsFixture();
      await rejectedWithoutSecrets(fixture.settings.save(saveInput({ port })));
      expect(await readdir(fixture.directory)).toEqual([]);
    });
  }

  test("requires the selected private address to still be assigned when enabling", async () => {
    let available = true;
    const fixture = await settingsFixture({ networkAddresses: () => available ? [{ address: "127.0.0.1", label: "Test loopback" }] : [] });
    await fixture.settings.save(saveInput());
    available = false;
    await rejectedWithoutSecrets(fixture.settings.configuration());
    available = true;
    expect((await configurationFields(fixture.settings))?.bindAddress).toBe("127.0.0.1");
  });

  test("rejects a certificate whose SAN does not cover the selected interface address", async () => {
    const fixture = await settingsFixture({ networkAddresses: () => [{ address: "192.168.1.10", label: "Test private LAN" }] });
    await rejectedWithoutSecrets(fixture.settings.save(saveInput({ bindAddress: "192.168.1.10" })));
    expect(await readdir(fixture.directory)).toEqual([]);
  });

  test.each(["not yet valid", "expired"] as const)("rejects a %s certificate", async (period) => {
    const now = period === "not yet valid" ? Date.parse(certificate.validFrom) - 1_000 : Date.parse(certificate.validTo) + 1_000;
    const fixture = await settingsFixture({ now: () => now });
    await rejectedWithoutSecrets(fixture.settings.save(saveInput()));
    expect(await readdir(fixture.directory)).toEqual([]);
  });

  test("rechecks certificate expiry before every enable configuration", async () => {
    let now = Date.parse(certificate.validFrom) + 5_000;
    const fixture = await settingsFixture({ now: () => now });
    await fixture.settings.save(saveInput());
    now = Date.parse(certificate.validTo);
    await rejectedWithoutSecrets(fixture.settings.configuration());
    expect(fixture.settings.snapshot().source).toBe("saved");
  });

  test("rejects a private key that does not match the selected certificate", async () => {
    const fixture = await settingsFixture({ chooseTlsFiles: async () => ({ certificatePath, privateKeyPath: otherPrivateKeyPath }) });
    await rejectedWithoutSecrets(fixture.settings.save(saveInput()));
    expect(await readdir(fixture.directory)).toEqual([]);
  });

  for (const field of ["certificate", "private key"] as const) {
    test.each(["directory", "fifo", "oversize", "missing", "invalid pem"] as const)(
      `rejects %s ${field} files without exposing paths or PEM content`, async (kind) => {
        if (kind === "fifo" && process.platform === "win32") return;
        const directory = await temporaryDirectory();
        const invalidPath = join(directory, "private-TLS-input");
        if (kind === "directory") await mkdir(invalidPath);
        if (kind === "fifo") execFileSync("mkfifo", [invalidPath], { stdio: "ignore" });
        if (kind === "oversize") await writeFile(invalidPath, Buffer.alloc(3 * 1024 * 1024, 65));
        if (kind === "invalid pem") await writeFile(invalidPath, "-----BEGIN SECRET TEST CONTENT-----\nnot a certificate");
        const fixture = await settingsFixture({ chooseTlsFiles: async () => field === "certificate"
          ? { certificatePath: invalidPath, privateKeyPath } : { certificatePath, privateKeyPath: invalidPath } });
        await rejectedWithoutSecrets(fixture.settings.save(saveInput()), [directory, "SECRET TEST CONTENT"]);
        expect(await readdir(fixture.directory)).toEqual([]);
      },
    );
  }

  test("rejects overlapping save, clear and configuration while native selection is pending", async () => {
    const selection = deferred<ReturnType<typeof tlsSelection> | undefined>();
    let selections = 0;
    const fixture = await settingsFixture({ chooseTlsFiles: async () => { selections += 1; return selection.promise; } });
    const saving = fixture.settings.save(saveInput());
    await until(() => selections === 1);
    expect(fixture.settings.snapshot().busy).toBe(true);
    await rejectedWithoutSecrets(fixture.settings.save(saveInput()));
    await rejectedWithoutSecrets(fixture.settings.clear());
    await rejectedWithoutSecrets(fixture.settings.configuration());
    expect(selections).toBe(1);
    selection.resolve(undefined);
    await saving;
    expect(fixture.settings.snapshot().busy).toBe(false);
    expect(await readdir(fixture.directory)).toEqual([]);
  });

  test("invalidation prevents a late picker result from replacing existing configuration", async () => {
    const selection = deferred<ReturnType<typeof tlsSelection> | undefined>();
    let pending = false;
    let selecting = false;
    const fixture = await settingsFixture({ chooseTlsFiles: async () => {
      if (!pending) return tlsSelection();
      selecting = true;
      return selection.promise;
    } });
    await fixture.settings.save(saveInput());
    const before = await readFile(fixture.settingsPath, "utf8");
    pending = true;
    const saving = fixture.settings.save(saveInput({ port: 4744 }));
    const settled = saving.then(() => undefined, (error: unknown) => error);
    await until(() => selecting);
    fixture.settings.invalidatePending();
    selection.resolve(tlsSelection());
    await settled;
    expect(await readFile(fixture.settingsPath, "utf8")).toBe(before);
    expect(fixture.settings.snapshot()).toMatchObject({ source: "saved", port: 4743, busy: false });
  });

  test.each(["certificate", "key"] as const)("revalidates a replaced %s file before returning enable configuration", async (kind) => {
    const directory = await temporaryDirectory();
    const localCertificate = join(directory, "certificate.pem");
    const localKey = join(directory, "key.pem");
    await copyFile(certificatePath, localCertificate);
    await copyFile(privateKeyPath, localKey);
    const fixture = await settingsFixture({ chooseTlsFiles: async () => ({ certificatePath: localCertificate, privateKeyPath: localKey }) });
    await fixture.settings.save(saveInput());
    if (kind === "certificate") await writeFile(localCertificate, "invalid replacement -----BEGIN SECRET CONTENT-----");
    else await copyFile(otherPrivateKeyPath, localKey);
    await rejectedWithoutSecrets(fixture.settings.configuration(), [directory, "SECRET CONTENT"]);
    expect(fixture.settings.snapshot().source).toBe("saved");
    await copyFile(certificatePath, localCertificate);
    await copyFile(privateKeyPath, localKey);
    expect((await configurationFields(fixture.settings))?.tlsCertPath).toBe(localCertificate);
  });

  test.each(["replaced", "deleted"] as const)("uses the validated TLS bytes when original paths are %s after configuration", async (change) => {
    const directory = await temporaryDirectory();
    const localCertificate = join(directory, "certificate.pem");
    const localKey = join(directory, "key.pem");
    await copyFile(certificatePath, localCertificate);
    await copyFile(privateKeyPath, localKey);
    const fixture = await settingsFixture({ chooseTlsFiles: async () => ({ certificatePath: localCertificate, privateKeyPath: localKey }) });
    await writeFile(join(fixture.directory, "index.html"), "<!doctype html><title>Prepared TLS</title>");
    await fixture.settings.save(saveInput());
    const prepared = await fixture.settings.configuration();
    if (!prepared?.tlsMaterial) throw new Error("Expected prepared TLS material");
    const material = prepared.tlsMaterial;
    expect(new X509Certificate(material.certificate).fingerprint256).toBe(certificate.fingerprint256);
    const host = new PrivateControlHttpsHost({ controlService: { invoke: () => ({ sessions: [] }) } });
    try {
      if (change === "replaced") {
        await copyFile(commonNameOnlyCertificatePath, localCertificate);
        await copyFile(otherPrivateKeyPath, localKey);
      } else {
        await rm(localCertificate);
        await rm(localKey);
      }
      const state = await host.enable({ ...prepared, port: 0, publicOrigin: "https://127.0.0.1:0" });
      expect(state.enabled).toBe(true);
      expect(material.certificate.every((byte) => byte === 0)).toBe(true);
      expect(material.privateKey.every((byte) => byte === 0)).toBe(true);
      const trustedCertificate = await readFile(certificatePath);
      const status = await new Promise<number | undefined>((accept, reject) => {
        const request = httpsRequest(new URL("/", state.origin), { ca: trustedCertificate, agent: false }, (response) => {
          response.resume();
          response.once("end", () => accept(response.statusCode));
          response.once("error", reject);
        });
        request.once("error", reject);
        request.end();
      });
      expect(status).toBe(200);
      await rejectedWithoutSecrets(fixture.settings.configuration(), [directory]);
      assertPublicSnapshot(fixture.settings, fixture.directory);
    } finally {
      disposePrivateControlTlsMaterial(material);
      await host.disable();
    }
  });

  test("failed atomic replacement preserves previous in-memory configuration and previous bytes", async () => {
    const fixture = await settingsFixture();
    await fixture.settings.save(saveInput());
    const before = await readFile(fixture.settingsPath, "utf8");
    const backup = join(fixture.directory, "previous-settings.json");
    await rename(fixture.settingsPath, backup);
    await mkdir(fixture.settingsPath);
    await rejectedWithoutSecrets(fixture.settings.save(saveInput({ tls: "keep", port: 4744 })), [fixture.directory]);
    expect(fixture.settings.snapshot()).toMatchObject({ source: "saved", port: 4743, busy: false });
    expect(await readFile(backup, "utf8")).toBe(before);
    expect((await configurationFields(fixture.settings))?.port).toBe(4743);
    expect((await readdir(fixture.directory)).sort()).toEqual(["previous-settings.json", "remote-control-settings.json"]);
  });

  test("malformed persisted configuration fails closed and reports a public error", async () => {
    const fixture = await settingsFixture();
    await writeFile(fixture.settingsPath, `not json ${fixture.directory} -----BEGIN PRIVATE KEY-----`);
    const settings = new DesktopRemoteSettings(fixture.options);
    await settings.initialize();
    expect(settings.snapshot().error).toBeTruthy();
    expect(settings.snapshot().hasTlsFiles).toBe(false);
    await rejectedWithoutSecrets(settings.configuration(), [fixture.directory]);
    assertPublicSnapshot(settings, fixture.directory);
  });
});

type SettingsOptions = ConstructorParameters<typeof DesktopRemoteSettings>[0];
type SaveInput = Parameters<DesktopRemoteSettings["save"]>[0];

/** Metadata-only assertions release prepared keys just as a cancelled manager call would. */
async function configurationFields(settings: DesktopRemoteSettings) {
  const prepared = await settings.configuration();
  if (!prepared) return undefined;
  const { tlsMaterial, ...fields } = prepared;
  disposePrivateControlTlsMaterial(tlsMaterial);
  return fields;
}

async function settingsFixture(overrides: Partial<SettingsOptions> = {}) {
  const directory = await temporaryDirectory();
  const settingsPath = join(directory, "remote-control-settings.json");
  const options: SettingsOptions = {
    settingsPath, environment: {}, defaultWebRoot: directory,
    chooseTlsFiles: async () => tlsSelection(),
    networkAddresses: () => [{ address: "127.0.0.1", label: "Test loopback" }],
    now: () => Date.parse(certificate.validFrom) + 5_000,
    ...overrides,
  };
  const settings = new DesktopRemoteSettings(options);
  await settings.initialize();
  return { settings, options, directory, settingsPath };
}

function saveInput(overrides: Partial<SaveInput> = {}): SaveInput {
  return { bindAddress: "127.0.0.1", port: 4743, tls: "select", ...overrides };
}

function tlsSelection() {
  return { certificatePath, privateKeyPath };
}

function environmentConfig(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    CHILI_REMOTE_BIND_ADDRESS: "127.0.0.1", CHILI_REMOTE_PORT: "4743", CHILI_REMOTE_ORIGIN: "https://127.0.0.1:4743",
    CHILI_REMOTE_TLS_CERT: certificatePath, CHILI_REMOTE_TLS_KEY: privateKeyPath, ...overrides,
  };
}

function assertPublicSnapshot(settings: DesktopRemoteSettings, directory: string): void {
  const snapshot = settings.snapshot();
  const serialized = JSON.stringify(snapshot);
  for (const secret of [directory, certificateDirectory, "-----BEGIN", "tlsCertPath", "tlsKeyPath", "certificatePath", "privateKeyPath"]) {
    expect(serialized).not.toContain(secret);
  }
  for (const field of ["enabled", "pairing", "devices", "credentials", "channelKey", "sequence", "replay"]) {
    expect(snapshot).not.toHaveProperty(field);
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "chili-remote-settings-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function rejectedWithoutSecrets(operation: Promise<unknown>, secrets: string[] = []): Promise<Error> {
  const result = await operation.then(() => undefined, (error: unknown) => error);
  expect(result).toBeInstanceOf(Error);
  const error = result as Error;
  const serialized = `${error.message} ${JSON.stringify(error)}`;
  for (const secret of [certificateDirectory, "-----BEGIN", ...secrets]) {
    expect(serialized).not.toContain(secret);
  }
  return error;
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((accept) => { resolve = accept; });
  return { promise, resolve };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  }
  throw new Error("Settings operation did not reach the expected boundary");
}
