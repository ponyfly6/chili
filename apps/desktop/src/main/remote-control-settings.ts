import { createPrivateKey, randomUUID, X509Certificate } from "node:crypto";
import { lookup } from "node:dns/promises";
import { constants, renameSync, unlinkSync } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { createSecureContext } from "node:tls";
import { disposePrivateControlTlsMaterial, isPrivateControlAddress, type PrivateControlTlsMaterial } from "@chili/remote-control";
import type { RemoteDesktopSetupState } from "../shared/remote-control-contracts.js";
import { remoteControlConfiguration, type DesktopRemoteHttpsConfig } from "./remote-control-config.js";

const DEFAULT_PORT = 4743;
const MAX_SETTINGS_BYTES = 16 * 1024;
const MAX_TLS_BYTES = 256 * 1024;
const MAX_ADDRESSES = 64;
const ENVIRONMENT_FIELDS = [
  "CHILI_REMOTE_BIND_ADDRESS", "CHILI_REMOTE_PORT", "CHILI_REMOTE_ORIGIN",
  "CHILI_REMOTE_TLS_CERT", "CHILI_REMOTE_TLS_KEY", "CHILI_REMOTE_WEB_ROOT",
] as const;

const MESSAGES = {
  busy: "Phone setup is already in progress. Wait for it to finish.",
  cancelled: "Phone setup was cancelled. Try again when the desktop is ready.",
  environment: "Phone HTTPS is configured by launch settings. Change those settings before editing here.",
  incompleteEnvironment: "Phone HTTPS launch settings are incomplete. Configure all required fields or remove them.",
  settings: "Saved phone setup could not be read. Choose the HTTPS files and save the setup again.",
  network: "Choose an available private address on this computer and a port from 1 to 65535.",
  origin: "The HTTPS address must use a private host and match the configured port.",
  files: "Choose readable certificate and private key files using the desktop file picker.",
  certificate: "The certificate must be valid now, match the HTTPS address, and match the selected private key.",
  save: "Phone setup could not be saved. The previous setup was kept.",
  clear: "Phone setup could not be cleared. The previous setup was kept.",
  unavailable: "Phone setup is not ready. Reopen the phone panel and try again.",
} as const;

class RemoteSettingsError extends Error {
  constructor(message: (typeof MESSAGES)[keyof typeof MESSAGES]) { super(message); }
}

interface SavedSettings {
  version: 1;
  bindAddress: string;
  port: number;
  tlsCertPath: string;
  tlsKeyPath: string;
}

export interface DesktopRemoteSettingsOptions {
  settingsPath: string;
  environment: NodeJS.ProcessEnv;
  defaultWebRoot: string;
  chooseTlsFiles: () => Promise<{ certificatePath: string; privateKeyPath: string } | undefined>;
  networkAddresses?: () => Array<{ address: string; label: string }>;
  now?: () => number;
}

interface SettingsOperation { epoch: number }

/** Main-only paths and TLS material never enter snapshot() or an IPC response. */
export class DesktopRemoteSettings {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly hasEnvironment: boolean;
  private saved: SavedSettings | undefined;
  private launch: DesktopRemoteHttpsConfig | undefined;
  private initialized = false;
  private epoch = 0;
  private operation: SettingsOperation | undefined;
  private error: string | undefined;
  private initializationError: RemoteSettingsError | undefined;

  constructor(private readonly options: DesktopRemoteSettingsOptions) {
    this.environment = { ...options.environment };
    this.hasEnvironment = ENVIRONMENT_FIELDS.some((field) => this.environment[field] !== undefined);
  }

  /** Invalid configuration is visible in the setup panel, never a desktop boot failure. */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    const operation = this.begin();
    try {
      if (this.hasEnvironment) {
        try {
          this.launch = remoteControlConfiguration(this.environment, this.options.defaultWebRoot);
          if (!this.launch) throw new RemoteSettingsError(MESSAGES.incompleteEnvironment);
        } catch {
          throw new RemoteSettingsError(MESSAGES.incompleteEnvironment);
        }
      } else {
        let bytes: Buffer;
        try { bytes = await readRegularFile(this.options.settingsPath, MAX_SETTINGS_BYTES); }
        catch (cause) {
          if (isMissing(cause)) return;
          throw new RemoteSettingsError(MESSAGES.settings);
        }
        this.assertCurrent(operation);
        try { this.saved = parseSavedSettings(JSON.parse(bytes.toString("utf8"))); }
        catch { throw new RemoteSettingsError(MESSAGES.settings); }
      }
      const configuration = this.currentConfiguration();
      if (configuration) {
        // Boot loads references only. DNS, removable files and TLS validation belong
        // to explicit save/enable, so a disabled phone connection cannot delay the UI.
        this.validateNetwork(configuration.bindAddress, configuration.port);
        this.validateOrigin(configuration);
      }
      this.assertCurrent(operation);
      this.error = undefined;
    } catch (cause) {
      const error = publicError(cause, MESSAGES.settings);
      this.initializationError = error;
      this.error = error.message;
    } finally {
      this.initialized = true;
      this.finish(operation);
    }
  }

  snapshot(): RemoteDesktopSetupState {
    const configuration = this.currentConfiguration();
    const addresses = this.addresses();
    const configuredAddress = configuration?.bindAddress;
    // Invalid launch input is untrusted text, not public network metadata.
    const bindAddress = configuredAddress !== undefined
      ? isPrivateControlAddress(configuredAddress) && configuredAddress.length <= 128 ? configuredAddress : undefined
      : addresses[0]?.address;
    return {
      source: this.hasEnvironment ? "environment" : this.saved ? "saved" : "none",
      addresses,
      ...(bindAddress ? { bindAddress } : {}),
      port: configuration?.port ?? DEFAULT_PORT,
      hasTlsFiles: Boolean(configuration?.tlsCertPath && configuration.tlsKeyPath),
      busy: this.operation !== undefined,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  async save(input: { bindAddress: string; port: number; tls: "keep" | "select" }): Promise<void> {
    this.requireEditable();
    const operation = this.begin();
    try {
      this.validateNetwork(input.bindAddress, input.port);
      if (input.tls !== "keep" && input.tls !== "select") throw new RemoteSettingsError(MESSAGES.files);
      let paths = this.saved && { certificatePath: this.saved.tlsCertPath, privateKeyPath: this.saved.tlsKeyPath };
      if (input.tls === "select") {
        try { paths = await this.options.chooseTlsFiles(); }
        catch { throw new RemoteSettingsError(MESSAGES.files); }
        this.assertCurrent(operation);
        if (!paths) return;
      }
      if (!paths) throw new RemoteSettingsError(MESSAGES.files);
      const candidate = parseSavedSettings({
        version: 1, bindAddress: input.bindAddress, port: input.port,
        tlsCertPath: paths.certificatePath, tlsKeyPath: paths.privateKeyPath,
      });
      disposePrivateControlTlsMaterial(await this.validate(this.savedConfiguration(candidate), operation));
      this.assertCurrent(operation);
      await this.persist(candidate, operation);
    } catch (cause) {
      const error = publicError(cause, MESSAGES.save);
      this.error = error.message;
      throw error;
    } finally { this.finish(operation); }
  }

  async clear(): Promise<void> {
    this.requireEditable();
    const operation = this.begin();
    try {
      this.assertCurrent(operation);
      // The small atomic filesystem commit and memory update share one JS turn.
      // An invalidation cannot interleave between the final check and the commit.
      try { unlinkSync(this.options.settingsPath); }
      catch (cause) { if (!isMissing(cause)) throw new RemoteSettingsError(MESSAGES.clear); }
      this.saved = undefined;
      this.initializationError = undefined;
      this.error = undefined;
    } catch (cause) {
      const error = publicError(cause, MESSAGES.clear);
      this.error = error.message;
      throw error;
    } finally { this.finish(operation); }
  }

  invalidatePending(): void { this.epoch += 1; }

  /** Caller owns the returned TLS buffers and must release them even if enable is cancelled. */
  async configuration(): Promise<DesktopRemoteHttpsConfig | undefined> {
    if (!this.initialized) throw new RemoteSettingsError(MESSAGES.unavailable);
    const operation = this.begin();
    let tlsMaterial: PrivateControlTlsMaterial | undefined;
    try {
      const configuration = this.currentConfiguration();
      if (!configuration) {
        if (this.initializationError) throw this.initializationError;
        return undefined;
      }
      tlsMaterial = await this.validate(configuration, operation);
      this.assertCurrent(operation);
      this.initializationError = undefined;
      this.error = undefined;
      const prepared = { ...configuration, tlsMaterial };
      tlsMaterial = undefined;
      return prepared;
    } catch (cause) {
      const error = publicError(cause, MESSAGES.certificate);
      this.error = error.message;
      throw error;
    } finally {
      disposePrivateControlTlsMaterial(tlsMaterial);
      this.finish(operation);
    }
  }

  private currentConfiguration(): DesktopRemoteHttpsConfig | undefined {
    return this.hasEnvironment ? this.launch : this.saved ? this.savedConfiguration(this.saved) : undefined;
  }

  private savedConfiguration(saved: SavedSettings): DesktopRemoteHttpsConfig {
    return {
      bindAddress: saved.bindAddress, port: saved.port,
      publicOrigin: privateOrigin(saved.bindAddress, saved.port),
      tlsCertPath: saved.tlsCertPath, tlsKeyPath: saved.tlsKeyPath,
      webRoot: resolve(this.options.defaultWebRoot),
    };
  }

  private requireEditable(): void {
    if (!this.initialized) throw new RemoteSettingsError(MESSAGES.unavailable);
    if (this.hasEnvironment) throw new RemoteSettingsError(MESSAGES.environment);
  }

  private begin(): SettingsOperation {
    if (this.operation) throw new RemoteSettingsError(MESSAGES.busy);
    const operation = { epoch: this.epoch };
    this.operation = operation;
    return operation;
  }

  private assertCurrent(operation: SettingsOperation): void {
    if (this.operation !== operation || operation.epoch !== this.epoch) throw new RemoteSettingsError(MESSAGES.cancelled);
  }

  private finish(operation: SettingsOperation): void {
    if (this.operation === operation) this.operation = undefined;
  }

  private addresses(): Array<{ address: string; label: string }> {
    try {
      const rows = (this.options.networkAddresses ?? defaultNetworkAddresses)();
      const seen = new Set<string>();
      const addresses: Array<{ address: string; label: string }> = [];
      for (const row of rows) {
        if (typeof row.address !== "string" || row.address.length > 128 || !isPrivateControlAddress(row.address)
          || row.address.includes("%") || /^fe[89ab][0-9a-f]:/iu.test(row.address) || seen.has(row.address)) continue;
        seen.add(row.address);
        // Labels are generated here, not copied from OS interface/hardware names.
        addresses.push({ address: row.address, label: addressLabel(row.address) });
        if (addresses.length >= MAX_ADDRESSES) break;
      }
      return addresses.sort((left, right) => addressPriority(left.address) - addressPriority(right.address));
    } catch { return []; }
  }

  private validateNetwork(address: string, port: number): void {
    if (typeof address !== "string" || !isPrivateControlAddress(address)
      || !Number.isSafeInteger(port) || port < 1 || port > 65_535
      || !this.addresses().some((row) => row.address === address)) throw new RemoteSettingsError(MESSAGES.network);
  }

  private validateOrigin(configuration: DesktopRemoteHttpsConfig): string {
    try {
      const origin = new URL(configuration.publicOrigin);
      if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash
        || origin.origin !== configuration.publicOrigin || Number(origin.port || 443) !== configuration.port) {
        throw new RemoteSettingsError(MESSAGES.origin);
      }
      const hostname = origin.hostname.replace(/^\[|\]$/gu, "");
      if (isIP(hostname) && !isPrivateControlAddress(hostname)) throw new RemoteSettingsError(MESSAGES.origin);
      return hostname;
    } catch (cause) { throw publicError(cause, MESSAGES.origin); }
  }

  private async validate(configuration: DesktopRemoteHttpsConfig, operation: SettingsOperation): Promise<PrivateControlTlsMaterial> {
    this.assertCurrent(operation);
    this.validateNetwork(configuration.bindAddress, configuration.port);
    const hostname = this.validateOrigin(configuration);
    try {
      if (!isIP(hostname)) {
        const resolved = await lookup(hostname, { all: true });
        this.assertCurrent(operation);
        if (resolved.length === 0 || resolved.some(({ address }) => !isPrivateControlAddress(address))) {
          throw new RemoteSettingsError(MESSAGES.origin);
        }
      }
    } catch (cause) { throw publicError(cause, MESSAGES.origin); }
    let certificate: Buffer | undefined;
    let privateKey: Buffer | undefined;
    try {
      try {
        certificate = await readRegularFile(configuration.tlsCertPath, MAX_TLS_BYTES);
        this.assertCurrent(operation);
        privateKey = await readRegularFile(configuration.tlsKeyPath, MAX_TLS_BYTES);
        this.assertCurrent(operation);
      } catch (cause) { throw publicError(cause, MESSAGES.files); }
      try {
        const leaf = new X509Certificate(certificate);
        const now = (this.options.now ?? Date.now)();
        if (!Number.isFinite(now) || now < Date.parse(leaf.validFrom) || now >= Date.parse(leaf.validTo)
          || !(isIP(hostname) ? leaf.checkIP(hostname) : leaf.checkHost(hostname, { subject: "never" }))
          || !leaf.checkPrivateKey(createPrivateKey(privateKey))) throw new RemoteSettingsError(MESSAGES.certificate);
        // Parse the full supplied chain with the same TLS backend as the host.
        createSecureContext({ cert: certificate, key: privateKey, minVersion: "TLSv1.2" });
      } catch (cause) { throw publicError(cause, MESSAGES.certificate); }
      this.assertCurrent(operation);
      this.validateNetwork(configuration.bindAddress, configuration.port);
      const material = { certificate, privateKey };
      certificate = undefined;
      privateKey = undefined;
      return material;
    } finally {
      certificate?.fill(0);
      privateKey?.fill(0);
    }
  }

  private async persist(candidate: SavedSettings, operation: SettingsOperation): Promise<void> {
    const temporary = `${this.options.settingsPath}.${randomUUID()}.tmp`;
    let committed = false;
    try {
      await mkdir(dirname(this.options.settingsPath), { recursive: true });
      this.assertCurrent(operation);
      const file = await open(temporary, "wx", 0o600);
      try {
        this.assertCurrent(operation);
        await file.writeFile(`${JSON.stringify(candidate, null, 2)}\n`, "utf8");
        await file.sync();
      } finally { await file.close(); }
      this.assertCurrent(operation);
      // Commit has no await: invalidating a pending setup cannot race a late rename.
      renameSync(temporary, this.options.settingsPath);
      this.saved = candidate;
      this.initializationError = undefined;
      this.error = undefined;
      committed = true;
    } finally {
      if (!committed) await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

function parseSavedSettings(value: unknown): SavedSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RemoteSettingsError(MESSAGES.settings);
  const row = value as Record<string, unknown>;
  const allowed = ["version", "bindAddress", "port", "tlsCertPath", "tlsKeyPath"];
  if (Object.keys(row).some((key) => !allowed.includes(key)) || row.version !== 1
    || typeof row.bindAddress !== "string" || row.bindAddress.length > 128 || !isPrivateControlAddress(row.bindAddress)
    || typeof row.port !== "number" || !Number.isSafeInteger(row.port) || row.port < 1 || row.port > 65_535
    || !validPath(row.tlsCertPath) || !validPath(row.tlsKeyPath)) throw new RemoteSettingsError(MESSAGES.settings);
  return { version: 1, bindAddress: row.bindAddress, port: row.port, tlsCertPath: row.tlsCertPath, tlsKeyPath: row.tlsKeyPath };
}

function validPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\0") && isAbsolute(value);
}

async function readRegularFile(path: string, maximumBytes: number): Promise<Buffer> {
  if (!validPath(path)) throw new RemoteSettingsError(MESSAGES.files);
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || info.size > maximumBytes) throw new RemoteSettingsError(MESSAGES.files);
    const buffer = Buffer.alloc(maximumBytes + 1);
    let bytes = 0;
    try {
      while (bytes <= maximumBytes) {
        const result = await file.read(buffer, bytes, buffer.length - bytes, bytes);
        if (result.bytesRead === 0) return Buffer.from(buffer.subarray(0, bytes));
        bytes += result.bytesRead;
        if (bytes > maximumBytes) throw new RemoteSettingsError(MESSAGES.files);
      }
      throw new RemoteSettingsError(MESSAGES.files);
    } finally { buffer.fill(0); }
  } finally { await file.close(); }
}

function privateOrigin(address: string, port: number): string {
  return new URL(`https://${isIP(address) === 6 ? `[${address}]` : address}:${port}`).origin;
}

function defaultNetworkAddresses(): Array<{ address: string; label: string }> {
  return Object.values(networkInterfaces()).flatMap((rows) => (rows ?? []).map(({ address }) => ({ address, label: addressLabel(address) })));
}

function addressLabel(address: string): string {
  const local = address === "::1" || address.startsWith("127.");
  return `${local ? "This computer" : "Private network"} · IPv${isIP(address)}`;
}

function addressPriority(address: string): number {
  if (address === "::1" || address.startsWith("127.")) return 2;
  return isIP(address) === 4 ? 0 : 1;
}

function isMissing(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && "code" in value && value.code === "ENOENT");
}

function publicError(value: unknown, fallback: (typeof MESSAGES)[keyof typeof MESSAGES]): RemoteSettingsError {
  return value instanceof RemoteSettingsError ? value : new RemoteSettingsError(fallback);
}
