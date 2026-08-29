import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  decideRendererAsset,
  isTrustedRendererUrl,
  productionSecurityHeaders,
  PRODUCTION_CSP,
} from "./window-security.js";

describe("production Electron security boundary", () => {
  test("keeps Node and DevTools out of the packaged renderer", async () => {
    const source = await readFile(resolve(import.meta.dirname, "window.ts"), "utf8");
    const security = await readFile(resolve(import.meta.dirname, "window-security.ts"), "utf8");
    expect(source).toContain("sandbox: true");
    expect(source).toContain("contextIsolation: true");
    expect(source).toContain("nodeIntegration: false");
    expect(source).toContain("webSecurity: true");
    expect(source).toContain("devTools: !app.isPackaged");
    expect(source).toContain("return app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL");
    expect(source).toContain("trustedWebContents.has(webContents.id)");
    expect(source).toContain("minWidth: 390");
    expect(source).toContain("minHeight: 620");
    expect(security).toContain("connect-src 'none'");
    expect(source).not.toContain("Access-Control-Allow-Origin");
  });

  test("registers IPC before loading the first renderer document", async () => {
    const source = await readFile(resolve(import.meta.dirname, "index.ts"), "utf8");
    const register = source.indexOf("registerDesktopIpc(mainWindow, control)");
    const load = source.indexOf("loadDesktopWindow(mainWindow)");
    expect(register).toBeGreaterThan(0);
    expect(load).toBeGreaterThan(register);
    expect(source).toContain("shouldUseMockKeychain({");
    expect(source).toContain("__CHILI_DESKTOP_LOCAL_AD_HOC_BUILD__");
    expect(source).toContain('app.commandLine.appendSwitch("use-mock-keychain")');
  });

  test("completes a deferred native quit after successful containment", async () => {
    const source = await readFile(resolve(import.meta.dirname, "index.ts"), "utf8");
    const shutdown = source.slice(source.indexOf("function finishShutdown"));
    const forceBranch = shutdown.slice(shutdown.indexOf("if (force)"), shutdown.indexOf("if (shutdownFinished)"));
    const successBranch = shutdown.slice(shutdown.indexOf("if (shutdownFinished)"));
    const mainProcessContainment = source.indexOf("controlService?.containMainProcesses()");
    const successfulFinish = source.indexOf("finishShutdown(false)");
    expect(mainProcessContainment).toBeGreaterThan(0);
    expect(successfulFinish).toBeGreaterThan(mainProcessContainment);
    expect(forceBranch).toContain("control?.forceContainGitProcessGroups()");
    expect(forceBranch).toContain("exitDesktopProcess(exitCode)");
    expect(successBranch).toContain("deferredElectronQuit.complete(exitCode)");
    expect(successBranch).not.toContain("mainWindow.destroy()");
    expect(source).toContain("new DeferredElectronQuit(exitDesktopProcess)");
    expect(source).toContain("reallyExit.call(process, code)");
    expect(source).toContain("await runSmokeScenario();");
    expect(source).toContain("app.quit();");
    expect(source).not.toContain("__CHILI_REPOSITORY_ROOT__");
  });

  test("quiesces renderer IPC before closing the desktop control plane", async () => {
    const source = await readFile(resolve(import.meta.dirname, "index.ts"), "utf8");
    const shutdown = source.slice(
      source.indexOf("function beginShutdown"),
      source.indexOf("function finishShutdown"),
    );
    const quiesceIpc = shutdown.indexOf("desktopIpc?.beginShutdown()");
    const closeControlPlane = shutdown.indexOf("controlService?.beginShutdown()");
    expect(quiesceIpc).toBeGreaterThan(0);
    expect(closeControlPlane).toBeGreaterThan(quiesceIpc);
    expect(shutdown).not.toContain("desktopIpc?.dispose()");
    expect(shutdown).not.toContain("mainWindow?.destroy()");

    const ipc = await readFile(resolve(import.meta.dirname, "ipc.ts"), "utf8");
    expect(ipc).toContain("shutdownGate.invoke(() => dispatchRequest(value))");
    expect(ipc).toContain('return { version: 1, streamId: "stream_shutdown" }');
    const ipcBeginShutdown = ipc.slice(
      ipc.indexOf("beginShutdown: () =>"),
      ipc.indexOf("dispose: () =>"),
    );
    expect(ipcBeginShutdown).not.toContain("removeHandler(DESKTOP_INVOKE_CHANNEL)");
    expect(ipcBeginShutdown).not.toContain("removeHandler(DESKTOP_EVENT_READY_CHANNEL)");
  });

  test("validates the sender frame and runtime request and response", async () => {
    const source = await readFile(resolve(import.meta.dirname, "ipc.ts"), "utf8");
    const dispatcher = await readFile(resolve(import.meta.dirname, "ipc-dispatcher.ts"), "utf8");
    expect(source).toContain("requireTrustedDesktopIpcSender");
    expect(dispatcher).toContain("parseDesktopRequest(value)");
    expect(dispatcher).toContain("parseDesktopResponse(request, response)");
  });

  test("accepts only the exact packaged custom-scheme host", () => {
    const policy = { packaged: true };
    expect(isTrustedRendererUrl("chili://app/index.html", policy)).toBe(true);
    expect(isTrustedRendererUrl("chili://app/settings/page", policy)).toBe(true);
    for (const input of [
      "chili://app.evil/index.html",
      "chili://app@evil/index.html",
      "chili://user@app/index.html",
      "chili://app:42/index.html",
      "https://app/index.html",
      "not a url",
    ]) expect(isTrustedRendererUrl(input, policy)).toBe(false);
  });

  test("rejects malformed, literal, encoded, and repeatedly encoded traversal", () => {
    const root = resolve("/packaged/renderer");
    const exists = () => true;
    expect(decideRendererAsset("not a url", root, exists)).toEqual({ status: 400 });
    expect(decideRendererAsset("chili://app/%ZZ", root, exists)).toEqual({ status: 400 });
    for (const path of [
      "../secret.txt",
      "%2e%2e/secret.txt",
      "%252e%252e/secret.txt",
      "..%2fsecret.txt",
      "%2e%2e%5csecret.txt",
    ]) {
      expect(decideRendererAsset(`chili://app/${path}`, root, exists)).toEqual({ status: 400 });
    }
  });

  test("distinguishes missing assets and returns only contained existing targets", () => {
    const root = resolve("/packaged/renderer");
    expect(decideRendererAsset("chili://app/missing.js", root, () => false)).toEqual({ status: 404 });
    expect(decideRendererAsset("chili://other/index.html", root, () => true)).toEqual({ status: 404 });
    expect(decideRendererAsset("chili://app/index.html", root, () => true)).toEqual({
      status: 200,
      target: resolve(root, "index.html"),
    });
    expect(decideRendererAsset("chili://app/", root, () => true)).toEqual({
      status: 200,
      target: resolve(root, "index.html"),
    });
  });

  test("replaces hostile response headers with the production CSP boundary", () => {
    const headers = productionSecurityHeaders(new Headers({
      "Content-Security-Policy": "default-src *",
      "Access-Control-Allow-Origin": "*",
    }));
    expect(headers.get("Content-Security-Policy")).toBe(PRODUCTION_CSP);
    expect(headers.get("Content-Security-Policy")).toContain("connect-src 'none'");
    expect(headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
