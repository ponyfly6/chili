import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { RemoteDesktopRequest, RemoteDesktopState } from "../shared/remote-control-contracts.js";
import { trappedTabTarget } from "./keyboard-navigation.js";
import {
  acceptRemoteSetupSave,
  editRemoteSetup,
  receiveRemoteSetup,
  RemotePanelActionGate,
  remoteSetupErrors,
  remoteSetupRequest,
  type RemoteSetupDraft,
} from "./remote-setup-model.js";
import "./remote-control-panel.css";

export function RemoteControlPanel({ embedded = false }: { embedded?: boolean } = {}) {
  const [open, setOpen] = useState(embedded);
  const [state, setState] = useState<RemoteDesktopState>();
  const [draft, setDraft] = useState(() => receiveRemoteSetup(undefined, undefined));
  const [error, setError] = useState("");
  const [action, setAction] = useState<RemoteDesktopRequest["type"]>();
  const gate = useRef(new RemotePanelActionGate());
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    if (embedded || !open || !dialog.current) return;
    const restoreTarget = trigger.current;
    dialog.current.querySelector<HTMLElement>("[data-remote-initial-focus]")?.focus();
    const appShell = document.querySelector<HTMLElement>(".app-shell");
    const previousInert = appShell?.inert ?? false;
    const previousAriaHidden = appShell?.getAttribute("aria-hidden") ?? null;
    if (appShell) {
      appShell.inert = true;
      appShell.setAttribute("aria-hidden", "true");
    }
    return () => {
      if (appShell) {
        appShell.inert = previousInert;
        if (previousAriaHidden === null) appShell.removeAttribute("aria-hidden");
        else appShell.setAttribute("aria-hidden", previousAriaHidden);
      }
      if (restoreTarget?.isConnected && !restoreTarget.closest("[inert]")) restoreTarget.focus();
    };
  }, [embedded, open]);

  useEffect(() => {
    if (!open || !window.chiliRemote) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const epoch = gate.current.revision;
      if (!gate.current.acceptsPoll(epoch)) {
        if (!disposed) timer = setTimeout(() => void poll(), 1_000);
        return;
      }
      try {
        const next = await window.chiliRemote.invoke({ type: "status" });
        if (!disposed && gate.current.acceptsPoll(epoch)) {
          setState(next);
          setDraft((current) => receiveRemoteSetup(current, next.setup));
        }
      } catch {
        if (!disposed && gate.current.acceptsPoll(epoch)) setError("Phone control status is unavailable. Close this panel and try again.");
      } finally {
        if (!disposed) timer = setTimeout(() => void poll(), 1_000);
      }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [open]);

  async function act(request: RemoteDesktopRequest) {
    const epoch = gate.current.begin(request.type);
    if (epoch === undefined) return;
    setAction(request.type);
    setError("");
    try {
      const next = await window.chiliRemote.invoke(request);
      if (gate.current.isCurrent(epoch)) {
        setState(next);
        setDraft((current) => request.type === "setup.clear"
          ? receiveRemoteSetup(undefined, next.setup)
          : request.type === "setup.save"
            ? acceptRemoteSetupSave(current, next)
            : receiveRemoteSetup(current, next.setup));
      }
    } catch (cause) {
      if (gate.current.isCurrent(epoch)) setError(cause instanceof Error ? cause.message : "Phone control could not complete that action. Try again.");
    } finally {
      if (gate.current.finish(epoch)) setAction(undefined);
    }
  }

  if (embedded) return <section className="remote-panel remote-panel-embedded">
    <RemoteControlPanelContent state={state} draft={draft} error={error} action={action}
      onEdit={(field, value) => setDraft((current) => editRemoteSetup(current, field, value))}
      onDiscardChanges={() => setDraft(receiveRemoteSetup(undefined, state?.setup))}
      onAction={(request) => void act(request)} />
  </section>;

  return <div className="remote-panel-anchor">
    <button ref={trigger} className="chrome-button" type="button" data-testid="remote-open" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
      Phone {state?.enabled ? "· On" : "· Off"}
    </button>
    {open ? createPortal(<div className="remote-panel-layer" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
      <section ref={dialog} className="remote-panel" role="dialog" aria-modal="true" aria-labelledby="remote-panel-title" tabIndex={-1} onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); return; }
        if (event.key !== "Tab") return;
        const focusables = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, a[href], [tabindex='0']"))
          .filter((element) => element.getClientRects().length > 0);
        const index = trappedTabTarget(focusables.indexOf(document.activeElement as HTMLElement), focusables.length, event.shiftKey);
        if (index === undefined) return;
        event.preventDefault();
        (focusables[index] ?? event.currentTarget).focus();
      }}>
        <RemoteControlPanelContent state={state} draft={draft} error={error} action={action}
          onEdit={(field, value) => setDraft((current) => editRemoteSetup(current, field, value))}
          onDiscardChanges={() => setDraft(receiveRemoteSetup(undefined, state?.setup))}
          onAction={(request) => void act(request)} onClose={() => setOpen(false)} />
      </section>
    </div>, document.body) : null}
  </div>;
}

export function RemoteControlPanelContent({ state, draft, error, action, onEdit, onDiscardChanges, onAction, onClose }: {
  state: RemoteDesktopState | undefined;
  draft: RemoteSetupDraft;
  error: string;
  action: RemoteDesktopRequest["type"] | undefined;
  onEdit: (field: "bindAddress" | "port", value: string) => void;
  onDiscardChanges: () => void;
  onAction: (request: RemoteDesktopRequest) => void;
  onClose?: () => void;
}) {
  const setup = state?.setup;
  const working = action !== undefined || Boolean(setup?.busy);
  const environment = setup?.source === "environment";
  const locked = working || Boolean(state?.enabled) || environment;
  const errors = remoteSetupErrors(draft, setup);
  const valid = !errors.address && !errors.port;
  const hasSelectedAddress = setup?.addresses.some((item) => item.address === draft.bindAddress);
  const save = (tls: "keep" | "select") => {
    if (!state || working) return;
    const request = remoteSetupRequest(draft, state, tls);
    if (request) onAction(request);
  };

  return <>
    {onClose ? <header className="remote-panel-heading"><div><p className="eyebrow">Private connection · Alpha</p><h2 id="remote-panel-title">Phone control</h2></div><button type="button" data-remote-initial-focus="true" aria-label="Close phone control" onClick={onClose}>×</button></header> : null}
    <div className="remote-panel-scroll">
      <p className="remote-panel-intro">Continue this workspace’s existing tasks on your phone. Approvals and questions stay on this Mac.</p>
      {error ? <p role="alert" className="remote-panel-error">{error}</p> : null}
      {setup?.error && setup.error !== error ? <p role="alert" className="remote-panel-error">{setup.error}</p> : null}
      <section className="remote-setup" aria-labelledby="remote-connection-title">
        <div className="remote-section-heading"><h3 id="remote-connection-title">Connection</h3><span>{environment ? "Launch settings" : setup?.source === "saved" ? "Saved on this Mac" : "Set up once"}</span></div>
        {!setup ? <p>Loading connection settings…</p> : environment ? <>
          <p>This connection is supplied by your launch settings. Change those settings to use a different address or certificate.</p>
          <dl className="remote-connection-details"><div><dt>Mac address</dt><dd>{setup.bindAddress ?? "Unavailable"}</dd></div><div><dt>Port</dt><dd>{setup.port}</dd></div><div><dt>Certificate</dt><dd>{setup.hasTlsFiles && !setup.error ? "Files selected" : "Needs attention"}</dd></div></dl>
        </> : <form noValidate onSubmit={(event) => { event.preventDefault(); save(setup.hasTlsFiles ? "keep" : "select"); }}>
          <div className="remote-setup-fields">
            <label className="remote-setup-address"><span>Mac address</span><select data-testid="remote-setup-address" aria-label="Mac address" value={draft.bindAddress} disabled={locked || setup.addresses.length === 0} aria-invalid={Boolean(errors.address)} aria-describedby={errors.address ? "remote-address-error" : "remote-address-help"} onChange={(event) => onEdit("bindAddress", event.target.value)}>
              {!draft.bindAddress ? <option value="">Choose an address</option> : null}
              {draft.bindAddress && !hasSelectedAddress ? <option value={draft.bindAddress}>{draft.bindAddress} · unavailable</option> : null}
              {setup.addresses.map(({ address, label }) => <option key={address} value={address}>{label} · {address}</option>)}
            </select></label>
            <label className="remote-setup-port"><span>Port</span><input data-testid="remote-setup-port" aria-label="Port" type="text" inputMode="numeric" maxLength={5} value={draft.port} disabled={locked} aria-invalid={Boolean(errors.port)} aria-describedby={errors.port ? "remote-port-error" : undefined} onChange={(event) => onEdit("port", event.target.value)} /></label>
          </div>
          {errors.address ? <p id="remote-address-error" className="remote-field-error">{errors.address}</p> : <p id="remote-address-help" className="remote-panel-hint">Use an address your phone can reach on the same private network.</p>}
          {errors.port ? <p id="remote-port-error" className="remote-field-error">{errors.port}</p> : null}
          <p className="remote-tls-status">{setup.hasTlsFiles ? "TLS files are saved. You can keep them when changing the connection." : "Choose the certificate, then its private key, in the two file dialogs."}</p>
          <div className="remote-setup-actions">
            <button className="remote-primary" type="submit" data-testid="remote-setup-save" disabled={locked || !valid}>{action === "setup.save" ? "Saving…" : setup.hasTlsFiles ? "Save connection" : "Choose TLS files and save"}</button>
            {setup.hasTlsFiles ? <button type="button" data-testid="remote-setup-replace-tls" disabled={locked || !valid} onClick={() => save("select")}>Replace TLS files</button> : null}
            {draft.dirty ? <button className="remote-text-button" type="button" data-testid="remote-setup-discard" disabled={locked} onClick={onDiscardChanges}>Discard edits</button> : null}
            {setup.source === "saved" ? <button className="remote-text-button" type="button" data-testid="remote-setup-clear" disabled={locked} onClick={() => onAction({ type: "setup.clear" })}>Clear saved setup</button> : null}
          </div>
          <p className="remote-panel-hint">{state?.enabled ? "Turn off phone control before changing this connection." : "Saving keeps phone control off. Cancelling a file dialog keeps your previous setup."}</p>
        </form>}
      </section>
      <section className="remote-connection-control" aria-label="Phone connection status">
        {!state?.enabled ? <button className="remote-primary" type="button" data-testid="remote-enable" disabled={working || !state?.configured || (!environment && draft.dirty)} onClick={() => onAction({ type: "enable" })}>{action === "enable" ? "Turning on…" : "Turn on phone control"}</button> : <p className="remote-panel-origin" data-testid="remote-status">Open this address on your phone:<strong>{state.origin}</strong></p>}
        {!state?.enabled && !environment && draft.dirty ? <p className="remote-panel-hint">Save or discard your edits before turning phone control on.</p> : null}
        {state?.enabled || working ? <button className="remote-text-button remote-danger" type="button" data-testid="remote-disable" onClick={() => onAction({ type: "disable" })}>Turn off and revoke devices</button> : null}
      </section>
      <details className="remote-trust-help"><summary>Your phone browser still needs to trust the certificate</summary><p>If your phone shows a certificate warning, use a certificate it already trusts, or ask the certificate issuer to help you trust it on the phone. Chili does not change trust settings.</p><p>If this Mac’s address changes, turn phone control off and choose TLS files that cover the new address, then turn it on again.</p></details>
      {state?.enabled ? <section className="remote-pairing-section" aria-labelledby="remote-pairing-title">
        <div className="remote-section-heading"><h3 id="remote-pairing-title">Pair your phone</h3></div>
        <button type="button" data-testid="remote-pairing-create" disabled={working} onClick={() => onAction({ type: "pairing.create" })}>Create one-time pairing code</button>
        {state.pairing ? <p>One-time code: <strong className="remote-pairing-code" data-testid="remote-code">{state.pairing.code}</strong><br />Expires {new Date(state.pairing.expiresAt).toLocaleTimeString()}. Enter it only at the address above.</p> : null}
        {state.pending.map((pair) => <div className="remote-panel-device" key={pair.pairingId}>
          <strong>{pair.label}</strong><code>{pair.deviceId}</code>
          <p>Confirm only the phone you just paired. It can read tasks, Queue, Steer and Stop.</p>
          <button type="button" data-testid="remote-pending-confirm" disabled={working} onClick={() => onAction({ type: "pairing.approve", pairingId: pair.pairingId })}>Confirm this device</button>
          <button type="button" disabled={working} onClick={() => onAction({ type: "pairing.reject", pairingId: pair.pairingId })}>Reject</button>
        </div>)}
        {state.devices.map((device) => <div className="remote-panel-device" key={device.deviceId}>
          <strong>{device.label}</strong><code>{device.deviceId}</code>
          <button type="button" data-testid="remote-revoke" disabled={working} onClick={() => onAction({ type: "device.revoke", deviceId: device.deviceId })}>Revoke device</button>
        </div>)}
        {state.devices.length === 0 ? <p className="remote-panel-hint">No paired devices.</p> : null}
      </section> : null}
      <p className="remote-panel-footnote">Turning this off, switching workspace or restarting revokes devices. Refreshing the phone requires pairing again.</p>
    </div>
  </>;
}
