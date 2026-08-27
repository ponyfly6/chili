import { describe, expect, test } from "bun:test";
import { requireTrustedDesktopIpcSender, type DesktopIpcSenderBoundary } from "./ipc-security.js";

describe("desktop IPC sender boundary", () => {
  test("accepts the exact packaged window, webContents, main frame, and custom origin", () => {
    expect(() => requireTrustedDesktopIpcSender(packagedBoundary(), { packaged: true })).not.toThrow();
  });

  test("rejects the wrong BrowserWindow, webContents, missing frame, and subframe", () => {
    const baseline = packagedBoundary();
    for (const change of [
      { ownerWindow: {} },
      { senderWebContents: {} },
      { senderFrame: undefined },
      { senderFrame: { url: "chili://app/index.html" } },
    ] as const) {
      expect(() => requireTrustedDesktopIpcSender({ ...baseline, ...change }, { packaged: true }))
        .toThrow("untrusted frame");
    }
  });

  test("rejects non-production origins in a packaged app", () => {
    for (const url of [
      "https://app/index.html",
      "chili://app.evil/index.html",
      "chili://app:42/index.html",
      "http://127.0.0.1:5173/index.html",
      "not a url",
    ]) {
      expect(() => requireTrustedDesktopIpcSender(packagedBoundary(url), { packaged: true }))
        .toThrow("untrusted origin");
    }
  });

  test("trusts only the configured development origin", () => {
    const policy = {
      packaged: false,
      developmentRendererUrl: "http://127.0.0.1:5173/app/index.html?dev=1",
    };
    expect(() => requireTrustedDesktopIpcSender(
      packagedBoundary("http://127.0.0.1:5173/another/path"),
      policy,
    )).not.toThrow();
    for (const url of [
      "chili://app/index.html",
      "http://127.0.0.1:5174/index.html",
      "https://127.0.0.1:5173/index.html",
      "http://localhost:5173/index.html",
      "http://127.0.0.1:5173.evil/index.html",
    ]) {
      expect(() => requireTrustedDesktopIpcSender(packagedBoundary(url), policy))
        .toThrow("untrusted origin");
    }
  });

  test("fails closed for absent, malformed, or credentialed development renderer configuration", () => {
    for (const developmentRendererUrl of [
      undefined,
      "not a url",
      "file:///tmp/renderer/index.html",
      "http://user:password@127.0.0.1:5173/index.html",
    ]) {
      expect(() => requireTrustedDesktopIpcSender(
        packagedBoundary("http://127.0.0.1:5173/index.html"),
        { packaged: false, developmentRendererUrl },
      )).toThrow("untrusted origin");
    }
  });
});

function packagedBoundary(url = "chili://app/index.html"): DesktopIpcSenderBoundary {
  const window = {};
  const webContents = {};
  const frame = { url };
  return {
    expectedWindow: window,
    ownerWindow: window,
    expectedWebContents: webContents,
    senderWebContents: webContents,
    expectedMainFrame: frame,
    senderFrame: frame,
  };
}
