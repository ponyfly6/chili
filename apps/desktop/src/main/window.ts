import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  net,
  nativeTheme,
  protocol,
  session,
  shell,
  type OnHeadersReceivedListenerDetails,
} from "electron";
import {
  decideRendererAsset,
  isAllowedExternalWindowOpen,
  isAllowedResultFrameNavigation,
  isTrustedRendererUrl,
  productionSecurityHeaders,
  PRODUCTION_CSP,
  RENDERER_HOST,
  RENDERER_SCHEME,
  responseSecurityHeaders,
  type RendererTrustPolicy,
} from "./window-security.js";
import {
  installResultPreviewProtocol,
  isResultPreviewDocumentUrl,
  RESULT_PREVIEW_SCHEME,
} from "./result-preview-protocol.js";

const trustedWebContents = new Set<number>();

protocol.registerSchemesAsPrivileged([{
  scheme: RENDERER_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: false,
  },
}, {
  scheme: RESULT_PREVIEW_SCHEME,
  privileges: { standard: true, secure: true },
}]);

export async function installRendererProtocol(): Promise<void> {
  await installResultPreviewProtocol();
  if (developmentRendererUrl()) return;
  const rendererRoot = resolve(import.meta.dirname, "../renderer");
  await protocol.handle(RENDERER_SCHEME, async (request) => {
    const decision = decideRendererAsset(request.url, rendererRoot, existsSync);
    if (decision.status !== 200) {
      return new Response(decision.status === 400 ? "Bad request" : "Not found", { status: decision.status });
    }
    const response = await net.fetch(pathToFileURL(decision.target).href);
    const headers = productionSecurityHeaders(response.headers);
    return new Response(response.body, { status: response.status, headers });
  });
}

export function configureSessionSecurity(): void {
  const developmentUrl = developmentRendererUrl();
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    return permission === "notifications"
      && webContents !== null
      && trustedWebContents.has(webContents.id)
      && isTrustedRendererUrl(requestingOrigin, {
        packaged: app.isPackaged,
        ...(developmentUrl ? { developmentRendererUrl: developmentUrl } : {}),
      });
  });
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(permission === "notifications"
      && webContents !== null
      && trustedWebContents.has(webContents.id)
      && isTrustedRendererUrl(details.requestingUrl, {
        packaged: app.isPackaged,
        ...(developmentUrl ? { developmentRendererUrl: developmentUrl } : {}),
      }));
  });

  if (developmentUrl) {
    const url = new URL(developmentUrl);
    const csp = [
      "default-src 'none'",
      "script-src 'self' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "frame-src chili-result:",
      `connect-src ${url.origin} ${url.protocol === "https:" ? `wss://${url.host}` : `ws://${url.host}`}`,
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; ");
    session.defaultSession.webRequest.onHeadersReceived(
      { urls: [`${url.origin}/*`] },
      (details, callback) => callback({
        responseHeaders: securityHeaders(details, csp),
      }),
    );
  }
}

export function createDesktopWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 390,
    minHeight: 620,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0c0c0b" : "#f1eee8",
    title: "Chili",
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const } : {}),
    webPreferences: {
      preload: resolve(import.meta.dirname, "../preload/index.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: true,
      devTools: !app.isPackaged && process.env.CHILI_DESKTOP_DISABLE_DEVTOOLS !== "1",
    },
  });
  trustedWebContents.add(window.webContents.id);
  window.webContents.once("destroyed", () => trustedWebContents.delete(window.webContents.id));

  window.webContents.setWindowOpenHandler(({ url, referrer }) => {
    if (isAllowedExternalWindowOpen(url, referrer.url, currentRendererTrustPolicy())) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-frame-navigate", (event) => {
    if (event.isMainFrame) {
      if (event.initiator && event.initiator !== window.webContents.mainFrame) event.preventDefault();
      return;
    }
    if (!isAllowedResultFrameNavigation({
      registeredDocument: isResultPreviewDocumentUrl(event.url),
      parentIsMainFrame: event.frame?.parent === window.webContents.mainFrame,
      initiatorIsMainFrame: event.initiator === window.webContents.mainFrame,
      hasInitiator: Boolean(event.initiator),
      currentUrl: event.frame?.url,
    })) event.preventDefault();
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (event.initiator && event.initiator !== window.webContents.mainFrame) {
      event.preventDefault();
      return;
    }
    if (isCurrentRendererUrl(url)) return;
    event.preventDefault();
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
  });
  window.once("ready-to-show", () => window.show());
  return window;
}

export async function loadDesktopWindow(window: BrowserWindow): Promise<void> {
  const developmentUrl = developmentRendererUrl();
  if (developmentUrl) await window.loadURL(developmentUrl);
  else await window.loadURL(`${RENDERER_SCHEME}://${RENDERER_HOST}/index.html`);
}

function isCurrentRendererUrl(input: string): boolean {
  return isTrustedRendererUrl(input, currentRendererTrustPolicy());
}

function currentRendererTrustPolicy(): RendererTrustPolicy {
  const developmentUrl = developmentRendererUrl();
  return {
    packaged: app.isPackaged,
    ...(developmentUrl ? { developmentRendererUrl: developmentUrl } : {}),
  };
}

function developmentRendererUrl(): string | undefined {
  return app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;
}

function isAllowedExternalUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:";
  } catch {
    return false;
  }
}

function securityHeaders(
  details: OnHeadersReceivedListenerDetails,
  csp: string,
): Record<string, string[]> {
  return responseSecurityHeaders(details.responseHeaders as Record<string, string[] | undefined> | undefined, csp);
}
