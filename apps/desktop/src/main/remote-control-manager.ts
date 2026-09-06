import { PrivateControlHttpsHost } from "@chili/remote-control";
import type { DesktopState } from "../shared/contracts.js";
import type { ChiliRemoteDesktopApi, RemoteDesktopRequest, RemoteDesktopState } from "../shared/remote-control-contracts.js";
import type { DesktopControlService } from "./control-service.js";
import { DesktopRemoteControlAdapter } from "./remote-control-adapter.js";
import { remoteControlConfiguration } from "./remote-control-config.js";

/** One listener per desktop window/runtime. No credentials survive its epoch. */
export class DesktopRemoteControlManager implements ChiliRemoteDesktopApi {
  private host: PrivateControlHttpsHost | undefined;
  private adapter: DesktopRemoteControlAdapter | undefined;
  private pairing: RemoteDesktopState["pairing"];
  private generation = 0;
  private transition = 0;
  private starting = false;
  private closing: Promise<void> = Promise.resolve();

  constructor(private readonly options: {
    controlService: DesktopControlService;
    environment: NodeJS.ProcessEnv;
    defaultWebRoot: string;
  }) {}

  observeSidecar(state: DesktopState, generation: number): void {
    if (this.host && (generation !== this.generation || state.sidecar.phase !== "healthy")) {
      void this.disable().catch(() => undefined);
    }
    this.generation = generation;
  }

  async invoke(request: RemoteDesktopRequest): Promise<RemoteDesktopState> {
    if (request.type === "disable") {
      await this.disable();
    } else if (request.type === "enable") {
      await this.enable();
    } else if (request.type !== "status") {
      const host = this.host;
      if (!host?.snapshot().enabled) throw new Error("Private phone control is off");
      if (request.type === "pairing.create") this.pairing = host.createPairing();
      else if (request.type === "pairing.approve") host.approvePairing(request.pairingId);
      else if (request.type === "pairing.reject") host.rejectPairing(request.pairingId);
      else if (request.type === "device.revoke") host.revokeDevice(request.deviceId);
    }
    return this.snapshot();
  }

  snapshot(): RemoteDesktopState {
    const current = this.host?.snapshot();
    let configured = false;
    try { configured = Boolean(remoteControlConfiguration(this.options.environment, this.options.defaultWebRoot)); } catch { /* Enable reports the configuration error. */ }
    const state: RemoteDesktopState = {
      configured,
      enabled: current?.enabled ?? false,
      pending: current?.pendingPairings.map((pair) => ({ ...pair })) ?? [],
      devices: current?.devices.map(({ deviceId, label, expiresAt }) => ({ deviceId, label, expiresAt })) ?? [],
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
    this.adapter?.revoke();
    this.adapter = undefined;
    const host = this.host;
    this.host = undefined;
    this.pairing = undefined;
    const previous = this.closing;
    this.closing = Promise.all([previous, host?.disable() ?? Promise.resolve()]).then(() => undefined);
    return this.closing;
  }

  private async enable(): Promise<void> {
    if (this.host?.snapshot().enabled) return;
    if (this.starting) throw new Error("Private HTTPS is already starting");
    const configuration = remoteControlConfiguration(this.options.environment, this.options.defaultWebRoot);
    if (!configuration) throw new Error("Configure CHILI_REMOTE_* HTTPS settings before enabling phone control");
    const epoch = ++this.transition;
    this.starting = true;
    await this.closing;
    if (epoch !== this.transition) return;
    let adapter: DesktopRemoteControlAdapter;
    try {
      adapter = new DesktopRemoteControlAdapter({ controlService: this.options.controlService });
    } catch (error) {
      this.starting = false;
      throw error;
    }
    const host = new PrivateControlHttpsHost({ controlService: adapter });
    this.adapter = adapter;
    this.host = host;
    try {
      await host.enable(configuration);
      if (epoch !== this.transition) {
        adapter.revoke();
        await host.disable();
      }
    } catch (error) {
      adapter.revoke();
      await host.disable();
      if (this.host === host) this.host = undefined;
      throw error;
    } finally {
      if (epoch === this.transition) this.starting = false;
    }
  }
}
