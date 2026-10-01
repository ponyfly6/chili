import { disposePrivateControlTlsMaterial, PrivateControlHttpsError, PrivateControlHttpsHost } from "@chili/remote-control";
import type { DesktopState } from "../shared/contracts.js";
import type { ChiliRemoteDesktopApi, RemoteDesktopRequest, RemoteDesktopSetupState, RemoteDesktopState } from "../shared/remote-control-contracts.js";
import type { DesktopControlService } from "./control-service.js";
import { DesktopRemoteControlAdapter } from "./remote-control-adapter.js";
import type { DesktopRemoteHttpsConfig } from "./remote-control-config.js";

export interface DesktopRemoteSettingsAccess {
  snapshot(): RemoteDesktopSetupState;
  save(input: { bindAddress: string; port: number; tls: "keep" | "select" }): Promise<void>;
  clear(): Promise<void>;
  invalidatePending(): void;
  configuration(): Promise<DesktopRemoteHttpsConfig | undefined>;
}

/** One listener per desktop window/runtime. No credentials survive its epoch. */
export class DesktopRemoteControlManager implements ChiliRemoteDesktopApi {
  private host: PrivateControlHttpsHost | undefined;
  private adapter: DesktopRemoteControlAdapter | undefined;
  private readonly revoking = new Set<DesktopRemoteControlAdapter>();
  private pairing: RemoteDesktopState["pairing"];
  private generation = 0;
  private transition = 0;
  private starting = false;
  private settingUp = false;
  private closing: Promise<void> = Promise.resolve();

  constructor(private readonly options: {
    controlService: DesktopControlService | (() => DesktopControlService);
    settings: DesktopRemoteSettingsAccess;
  }) {}

  observeSidecar(state: DesktopState, generation: number): void {
    if ((this.host || this.starting || this.settingUp) && (generation !== this.generation || state.sidecar.phase !== "healthy")) {
      void this.disable().catch(() => undefined);
    }
    this.generation = generation;
  }

  async invoke(request: RemoteDesktopRequest): Promise<RemoteDesktopState> {
    if (request.type === "disable") {
      await this.disable();
    } else if (request.type === "setup.save" || request.type === "setup.clear") {
      await this.configure(request);
    } else if (request.type === "enable") {
      await this.enable();
    } else if (request.type !== "status") {
      const host = this.host;
      if (!host?.snapshot().enabled) throw new Error("Private phone control is off");
      if (request.type === "pairing.create") this.pairing = host.createPairing();
      else if (request.type === "pairing.approve") host.approvePairing(request.pairingId);
      else if (request.type === "pairing.reject") host.rejectPairing(request.pairingId);
      else if (request.type === "device.revoke") {
        host.revokeDevice(request.deviceId);
        await this.adapter?.revokeDevice(request.deviceId);
      }
    }
    return this.snapshot();
  }

  snapshot(): RemoteDesktopState {
    const current = this.host?.snapshot();
    const setup = this.options.settings.snapshot();
    const state: RemoteDesktopState = {
      // A temporary NIC or file error must remain retryable after it is fixed.
      configured: setup.hasTlsFiles,
      enabled: current?.enabled ?? false,
      pending: current?.pendingPairings.map((pair) => ({ ...pair })) ?? [],
      devices: current?.devices.map(({ deviceId, label, expiresAt }) => ({ deviceId, label, expiresAt })) ?? [],
      setup: { ...setup, busy: setup.busy || this.settingUp || this.starting },
    };
    if (current?.origin) state.origin = current.origin;
    if (this.pairing && current?.invitationExpiresAt === this.pairing.expiresAt && Date.now() < this.pairing.expiresAt) {
      state.pairing = { ...this.pairing };
    }
    return state;
  }

  /** Revoke synchronously before waiting for socket shutdown or workspace IO. */
  disable(): Promise<void> {
    this.transition += 1;
    this.starting = false;
    this.options.settings.invalidatePending();
    if (this.adapter) this.revoking.add(this.adapter);
    const revocations = [...this.revoking].map(async (adapter) => {
      await adapter.revoke();
      this.revoking.delete(adapter);
    });
    this.adapter = undefined;
    const host = this.host;
    this.host = undefined;
    this.pairing = undefined;
    const previous = this.closing;
    this.closing = Promise.all([previous.catch(() => undefined), host?.disable() ?? Promise.resolve(), ...revocations]).then(() => undefined);
    return this.closing;
  }

  private async enable(): Promise<void> {
    if (this.host?.snapshot().enabled) return;
    if (this.starting || this.settingUp || this.options.settings.snapshot().busy) throw new Error("Phone setup is already in progress");
    const epoch = ++this.transition;
    this.starting = true;
    let adapter: DesktopRemoteControlAdapter | undefined;
    let host: PrivateControlHttpsHost | undefined;
    let configuration: DesktopRemoteHttpsConfig | undefined;
    try {
      await this.closing;
      if (epoch !== this.transition) return;
      configuration = await this.options.settings.configuration();
      if (epoch !== this.transition) return;
      if (!configuration) throw new Error("Set up the connection and select TLS files before enabling phone access");
      adapter = new DesktopRemoteControlAdapter({ controlService: typeof this.options.controlService === "function" ? this.options.controlService() : this.options.controlService });
      host = new PrivateControlHttpsHost({ controlService: adapter });
      this.adapter = adapter;
      this.host = host;
      await host.enable(configuration);
      if (epoch !== this.transition) {
        await Promise.all([adapter.revoke(), host.disable()]);
      }
    } catch (error) {
      await Promise.allSettled([adapter?.revoke(), host?.disable()]);
      if (host && this.host === host) this.host = undefined;
      if (adapter && this.adapter === adapter) this.adapter = undefined;
      if (epoch !== this.transition) return;
      // File reads and OpenSSL can put local filenames in their errors. Setup
      // reports its own fixed diagnostics; never forward raw listener errors.
      const setupError = this.options.settings.snapshot().error;
      if (setupError) throw new Error(setupError);
      if (error instanceof PrivateControlHttpsError) throw new Error(error.message);
      if (typeof error === "object" && error !== null && "code" in error && error.code === "EADDRINUSE") {
        throw new Error("This port is already in use. Choose another port and save the connection.");
      }
      throw new Error("Phone access could not start. Check the connection, TLS files and workspace, then try again.");
    } finally {
      disposePrivateControlTlsMaterial(configuration?.tlsMaterial);
      if (epoch === this.transition) this.starting = false;
    }
  }

  private async configure(request: Extract<RemoteDesktopRequest, { type: "setup.save" }> | { type: "setup.clear" }): Promise<void> {
    if (this.host || this.starting) throw new Error("Turn off phone access before changing its setup");
    if (this.settingUp || this.options.settings.snapshot().busy) throw new Error("Phone setup is already in progress");
    const epoch = ++this.transition;
    this.settingUp = true;
    try {
      await this.closing;
      if (epoch !== this.transition) return;
      if (request.type === "setup.save") await this.options.settings.save({ bindAddress: request.bindAddress, port: request.port, tls: request.tls });
      else await this.options.settings.clear();
    } catch (error) {
      if (epoch === this.transition) throw error;
    } finally {
      // Keep admission closed until a cancelled native picker actually returns.
      this.settingUp = false;
    }
  }
}
