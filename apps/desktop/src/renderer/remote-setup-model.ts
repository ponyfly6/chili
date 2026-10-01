import type { RemoteDesktopRequest, RemoteDesktopState } from "../shared/remote-control-contracts.js";

export type RemoteSetupState = NonNullable<RemoteDesktopState["setup"]>;

export interface RemoteSetupDraft {
  bindAddress: string;
  port: string;
  dirty: boolean;
}

export function receiveRemoteSetup(draft: RemoteSetupDraft | undefined, setup: RemoteSetupState | undefined): RemoteSetupDraft {
  if (draft?.dirty || !setup) return draft ?? { bindAddress: "", port: "4743", dirty: false };
  return {
    bindAddress: setup.bindAddress ?? setup.addresses[0]?.address ?? "",
    port: String(setup.port),
    dirty: false,
  };
}

export function editRemoteSetup(draft: RemoteSetupDraft, field: "bindAddress" | "port", value: string): RemoteSetupDraft {
  return { ...draft, [field]: value, dirty: true };
}

export function remoteSetupErrors(draft: RemoteSetupDraft, setup: RemoteSetupState | undefined): { address?: string; port?: string } {
  const errors: { address?: string; port?: string } = {};
  if (!setup?.addresses.some((item) => item.address === draft.bindAddress)) {
    errors.address = setup?.addresses.length
      ? "Choose an available address on this Mac."
      : "Connect this Mac to your local network to choose an address.";
  }
  const port = Number(draft.port);
  if (!/^\d+$/.test(draft.port) || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    errors.port = "Enter a port from 1 to 65535.";
  }
  return errors;
}

export function remoteSetupRequest(
  draft: RemoteSetupDraft,
  state: RemoteDesktopState,
  tls: "keep" | "select",
): Extract<RemoteDesktopRequest, { type: "setup.save" }> | undefined {
  const setup = state.setup;
  if (!setup || state.enabled || setup.busy || setup.source === "environment") return undefined;
  if (tls === "keep" && !setup.hasTlsFiles) return undefined;
  if (Object.keys(remoteSetupErrors(draft, setup)).length > 0) return undefined;
  return { type: "setup.save", bindAddress: draft.bindAddress, port: Number(draft.port), tls };
}

/** A cancelled native picker returns the previous setup; keep unsaved edits intact. */
export function acceptRemoteSetupSave(draft: RemoteSetupDraft, state: RemoteDesktopState): RemoteSetupDraft {
  const setup = state.setup;
  if (setup?.source !== "saved" || !setup.hasTlsFiles || setup.error
    || setup.bindAddress !== draft.bindAddress || setup.port !== Number(draft.port)) return draft;
  return receiveRemoteSetup(undefined, setup);
}

/** Disable supersedes in-flight actions; their late results cannot turn the UI back on. */
export class RemotePanelActionGate {
  private epoch = 0;
  private pending = false;

  get revision(): number { return this.epoch; }

  begin(type: RemoteDesktopRequest["type"]): number | undefined {
    if (this.pending && type !== "disable") return undefined;
    this.pending = true;
    this.epoch += 1;
    return this.epoch;
  }

  isCurrent(epoch: number): boolean { return epoch === this.epoch; }

  acceptsPoll(epoch: number): boolean { return this.isCurrent(epoch) && !this.pending; }

  finish(epoch: number): boolean {
    if (!this.isCurrent(epoch)) return false;
    this.pending = false;
    return true;
  }
}
