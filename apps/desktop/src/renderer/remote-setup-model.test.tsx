import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RemoteDesktopRequest, RemoteDesktopState } from "../shared/remote-control-contracts.js";
import { RemoteControlPanelContent } from "./RemoteControlPanel.js";
import {
  acceptRemoteSetupSave,
  editRemoteSetup,
  receiveRemoteSetup,
  RemotePanelActionGate,
  remoteSetupErrors,
  remoteSetupRequest,
  type RemoteSetupDraft,
  type RemoteSetupState,
} from "./remote-setup-model.js";

function setup(overrides: Partial<RemoteSetupState> = {}): RemoteSetupState {
  return {
    source: "none",
    addresses: [{ address: "192.168.1.8", label: "Wi-Fi" }, { address: "10.0.0.8", label: "Ethernet" }],
    port: 4743,
    hasTlsFiles: false,
    busy: false,
    ...overrides,
  };
}

function state(connection: RemoteSetupState = setup(), overrides: Partial<RemoteDesktopState> = {}): RemoteDesktopState {
  return { enabled: false, configured: connection.hasTlsFiles, pending: [], devices: [], setup: connection, ...overrides };
}

function renderPanel(current: RemoteDesktopState, options: { draft?: RemoteSetupDraft; action?: RemoteDesktopRequest["type"] } = {}): string {
  return renderToStaticMarkup(<RemoteControlPanelContent state={current}
    draft={options.draft ?? receiveRemoteSetup(undefined, current.setup)} error="" action={options.action}
    onEdit={() => undefined} onDiscardChanges={() => undefined} onAction={() => undefined} onClose={() => undefined} />);
}

function button(html: string, id: string): string {
  const tag = html.match(new RegExp(`<button[^>]*data-testid="${id}"[^>]*>`))?.[0];
  if (!tag) throw new Error(`Missing button: ${id}`);
  return tag;
}

describe("phone connection drafts", () => {
  test("first load uses a local address and the default port without enabling anything", () => {
    const current = state();
    const draft = receiveRemoteSetup(undefined, current.setup);
    expect(draft).toEqual({ bindAddress: "192.168.1.8", port: "4743", dirty: false });
    expect(remoteSetupRequest(draft, current, "select")).toEqual({
      type: "setup.save", bindAddress: "192.168.1.8", port: 4743, tls: "select",
    });
    expect(remoteSetupRequest(draft, current, "keep")).toBeUndefined();
    expect(current.enabled).toBe(false);
  });

  test("status polling cannot replace partial edits, even after addresses change", () => {
    const draft = editRemoteSetup(receiveRemoteSetup(undefined, setup()), "port", "47");
    const polled = receiveRemoteSetup(draft, setup({ addresses: [{ address: "10.0.0.9", label: "Ethernet" }], port: 8443 }));
    expect(polled).toBe(draft);
    expect(polled.port).toBe("47");
    expect(remoteSetupErrors(polled, setup({ addresses: [] })).address).toContain("local network");
  });

  test("cancelled TLS selection preserves both previous configuration and unsaved network edits", () => {
    const previous = state(setup({ source: "saved", bindAddress: "192.168.1.8", hasTlsFiles: true }));
    const draft = editRemoteSetup(receiveRemoteSetup(undefined, previous.setup), "port", "8443");
    expect(acceptRemoteSetupSave(draft, previous)).toBe(draft);
    expect(previous.setup?.port).toBe(4743);
    const saved = state(setup({ source: "saved", bindAddress: "192.168.1.8", hasTlsFiles: true, port: 8443 }));
    expect(acceptRemoteSetupSave(draft, saved)).toEqual({ bindAddress: "192.168.1.8", port: "8443", dirty: false });
    expect(saved.enabled).toBe(false);
  });

  test.each(["", "0", "65536", "-1", "1.5", "1e3", " 4743", "47x"])("rejects invalid port %j before a setup request", (port) => {
    const current = state();
    const draft = editRemoteSetup(receiveRemoteSetup(undefined, current.setup), "port", port);
    expect(remoteSetupRequest(draft, current, "select")).toBeUndefined();
    expect(remoteSetupErrors(draft, current.setup).port).toBeDefined();
  });

  test("accepts boundary ports but rejects an address that is no longer on this Mac", () => {
    const current = state();
    for (const port of ["1", "65535"]) {
      expect(remoteSetupRequest({ bindAddress: "192.168.1.8", port, dirty: true }, current, "select")?.port).toBe(Number(port));
    }
    expect(remoteSetupRequest({ bindAddress: "192.168.1.9", port: "4743", dirty: true }, current, "select")).toBeUndefined();
  });

  test("enabled, busy and environment connections cannot be edited", () => {
    for (const current of [state(setup(), { enabled: true }), state(setup({ busy: true })), state(setup({ source: "environment" }))]) {
      expect(remoteSetupRequest(receiveRemoteSetup(undefined, current.setup), current, "select")).toBeUndefined();
    }
  });
});

describe("phone action ordering", () => {
  test.each(["setup.save", "enable"] as const)("disable supersedes %s and discards its late response", (action) => {
    const gate = new RemotePanelActionGate();
    const poll = gate.revision;
    const initial = gate.begin(action)!;
    expect(gate.begin("setup.save")).toBeUndefined();
    expect(gate.begin("enable")).toBeUndefined();
    expect(gate.acceptsPoll(poll)).toBe(false);
    expect(gate.acceptsPoll(initial)).toBe(false);
    const disabling = gate.begin("disable")!;
    expect(disabling).toBeGreaterThan(initial);
    expect(gate.finish(initial)).toBe(false);
    expect(gate.isCurrent(initial)).toBe(false);
    expect(gate.begin("enable")).toBeUndefined();
    expect(gate.finish(disabling)).toBe(true);
    expect(gate.acceptsPoll(disabling)).toBe(true);
    expect(gate.begin("enable")).toBeGreaterThan(disabling);
  });
});

describe("phone setup rendering", () => {
  test("first-run setup uses native TLS selection and keeps enable unavailable until saved", () => {
    const html = renderPanel(state());
    expect(html).toContain("Choose TLS files and save");
    expect(html).toContain('data-testid="remote-setup-address"');
    expect(html).toContain('value="4743"');
    expect(html).toContain("Your phone browser still needs to trust the certificate");
    expect(html).toContain("Saving keeps phone control off");
    expect(button(html, "remote-enable")).toContain("disabled");
    expect(button(html, "remote-setup-save")).not.toContain("disabled");
    expect(html).not.toContain("CHILI_REMOTE_");
    expect(html).not.toContain('type="file"');
  });

  test("saved TLS can be retained or replaced; errors remain recoverable without hiding Enable", () => {
    const html = renderPanel(state(setup({ source: "saved", bindAddress: "192.168.1.8", hasTlsFiles: true, error: "The address is temporarily unavailable." })));
    expect(html).toContain("Save connection");
    expect(html).toContain("Replace TLS files");
    expect(html).toContain('role="alert"');
    expect(button(html, "remote-enable")).not.toContain("disabled");
    expect(button(html, "remote-setup-clear")).not.toContain("disabled");
  });

  test.each(["setup.save", "enable"] as const)("%s disables reentry while Turn off and Close remain available", (action) => {
    const html = renderPanel(state(setup({ source: "saved", bindAddress: "192.168.1.8", hasTlsFiles: true })), { action });
    expect(button(html, "remote-enable")).toContain("disabled");
    expect(button(html, "remote-setup-save")).toContain("disabled");
    expect(button(html, "remote-disable")).not.toContain("disabled");
    expect(html.match(/<button[^>]*aria-label="Close phone control"[^>]*>/)?.[0]).not.toContain("disabled");
  });

  test("dirty edits require save or discard before enabling a saved connection", () => {
    const current = state(setup({ source: "saved", bindAddress: "192.168.1.8", hasTlsFiles: true }));
    const draft = editRemoteSetup(receiveRemoteSetup(undefined, current.setup), "port", "8443");
    const html = renderPanel(current, { draft });
    expect(button(html, "remote-enable")).toContain("disabled");
    expect(button(html, "remote-setup-discard")).not.toContain("disabled");
  });

  test("environment setup is read-only and enabled setup still offers cancellation", () => {
    const html = renderPanel(state(setup({ source: "environment", bindAddress: "192.168.1.8", hasTlsFiles: true }), { enabled: true, origin: "https://192.168.1.8:4743" }));
    expect(html).toContain("supplied by your launch settings");
    expect(html).toContain("<dt>Certificate</dt><dd>Files selected</dd>");
    expect(html).not.toContain('data-testid="remote-setup-save"');
    expect(html).not.toContain('data-testid="remote-setup-clear"');
    expect(html).not.toContain('data-testid="remote-setup-address"');
    expect(button(html, "remote-disable")).not.toContain("disabled");
    expect(html).toContain("https://192.168.1.8:4743");
  });

  test("environment certificate errors need attention even when files are selected", () => {
    const html = renderPanel(state(setup({ source: "environment", hasTlsFiles: true, error: "The certificate could not be validated." })));
    expect(html).toContain("<dt>Certificate</dt><dd>Needs attention</dd>");
    expect(html).not.toContain("<dd>Files selected</dd>");
  });
});
