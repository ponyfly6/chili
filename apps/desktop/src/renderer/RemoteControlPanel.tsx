import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { RemoteDesktopRequest, RemoteDesktopState } from "../shared/remote-control-contracts.js";
import "./remote-control-panel.css";

export function RemoteControlPanel() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<RemoteDesktopState>();
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const actionEpoch = useRef(0);

  useEffect(() => {
    if (!open || !window.chiliRemote) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const epoch = actionEpoch.current;
      try {
        const next = await window.chiliRemote.invoke({ type: "status" });
        if (!disposed && epoch === actionEpoch.current) setState(next);
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : "Remote status unavailable");
      } finally {
        if (!disposed) timer = setTimeout(() => void poll(), 1_000);
      }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [open]);

  async function act(request: RemoteDesktopRequest) {
    const epoch = ++actionEpoch.current;
    setWorking(true);
    setError("");
    try {
      const next = await window.chiliRemote.invoke(request);
      if (epoch === actionEpoch.current) setState(next);
    } catch (cause) {
      if (epoch === actionEpoch.current) setError(cause instanceof Error ? cause.message : "Remote operation failed");
    } finally {
      if (epoch === actionEpoch.current) setWorking(false);
    }
  }

  return <div className="remote-panel-anchor">
    <button className="chrome-button" type="button" data-testid="remote-open" aria-expanded={open} onClick={() => setOpen(!open)}>
      Phone {state?.enabled ? "· On" : "· Off"}
    </button>
    {open ? createPortal(<section className="remote-panel" aria-label="Private phone control">
      <div className="remote-panel-heading"><strong>Private phone control · Alpha</strong><button type="button" aria-label="Close phone control" onClick={() => setOpen(false)}>×</button></div>
      <p>Only existing tasks in this workspace. Approval and questions stay on this desktop.</p>
      <p>Switching workspace, restarting, or turning this off revokes all devices. Refreshing the phone requires pairing again.</p>
      {error ? <p role="alert" className="remote-panel-error">{error}</p> : null}
      {!state?.configured ? <p>HTTPS setup required. Set CHILI_REMOTE_BIND_ADDRESS, CHILI_REMOTE_PORT, CHILI_REMOTE_ORIGIN, CHILI_REMOTE_TLS_CERT and CHILI_REMOTE_TLS_KEY before launching. No system trust settings are changed.</p> : null}
      {!state?.enabled ? <button type="button" data-testid="remote-enable" disabled={working || !state?.configured} onClick={() => void act({ type: "enable" })}>Enable private HTTPS</button>
        : <>
          <p className="remote-panel-origin" data-testid="remote-status">Enabled · Open on phone: <strong>{state.origin}</strong></p>
          <button type="button" data-testid="remote-disable" onClick={() => void act({ type: "disable" })}>Turn off and revoke all devices</button>
          <hr />
          <button type="button" data-testid="remote-pairing-create" disabled={working} onClick={() => void act({ type: "pairing.create" })}>Create one-time pairing code</button>
          {state.pairing ? <p>One-time code: <strong data-testid="remote-code">{state.pairing.code}</strong><br />Expires {new Date(state.pairing.expiresAt).toLocaleTimeString()}. Enter it only on your phone at the address above.</p> : null}
          {state.pending.map((pair) => <div className="remote-panel-device" key={pair.pairingId}>
            <strong>{pair.label}</strong><code>{pair.deviceId}</code>
            <p>Confirm only the phone you just paired. Grants read, Queue, Steer and Stop.</p>
            <button type="button" data-testid="remote-pending-confirm" disabled={working} onClick={() => void act({ type: "pairing.approve", pairingId: pair.pairingId })}>Confirm this device</button>
            <button type="button" disabled={working} onClick={() => void act({ type: "pairing.reject", pairingId: pair.pairingId })}>Reject</button>
          </div>)}
          {state.devices.map((device) => <div className="remote-panel-device" key={device.deviceId}>
            <strong>{device.label}</strong><code>{device.deviceId}</code>
            <button type="button" data-testid="remote-revoke" disabled={working} onClick={() => void act({ type: "device.revoke", deviceId: device.deviceId })}>Revoke device</button>
          </div>)}
          {state.devices.length === 0 ? <p>No paired devices.</p> : null}
        </>}
    </section>, document.body) : null}
  </div>;
}
