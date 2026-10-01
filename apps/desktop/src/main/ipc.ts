import {
  app,
  BrowserWindow,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import {
  DESKTOP_EVENT_ACK_CHANNEL,
  DESKTOP_EVENT_CHANNEL,
  DESKTOP_EVENT_READY_CHANNEL,
  DESKTOP_INVOKE_CHANNEL,
  parseDesktopEventAck,
  type DesktopEvent,
  type DesktopResyncReason,
} from "../shared/contracts.js";
import { DesktopIpcAdmission } from "./ipc-admission.js";
import {
  createDesktopInvokeShutdownGate,
  createDesktopRequestDispatcher,
  type DesktopRequestHandler,
} from "./ipc-dispatcher.js";
import { DesktopEventOutbox } from "./ipc-outbox.js";
import { requireTrustedDesktopIpcSender } from "./ipc-security.js";
import { safeDesktopErrorMessage } from "../shared/safe-error.js";
import {
  REMOTE_DESKTOP_CHANNEL,
  parseRemoteDesktopRequest,
  parseRemoteDesktopState,
  type ChiliRemoteDesktopApi,
} from "../shared/remote-control-contracts.js";

export interface DesktopIpcController {
  publish(event: DesktopEvent): void;
  requestResync(reason: DesktopResyncReason): void;
  beginShutdown(): void;
  dispose(): void;
}


export function registerDesktopIpc(
  window: BrowserWindow,
  handler: DesktopRequestHandler,
  remote?: ChiliRemoteDesktopApi,
): DesktopIpcController {
  const admission = new DesktopIpcAdmission();
  const outbox = new DesktopEventOutbox({
    send: (envelope) => {
      if (window.isDestroyed() || window.webContents.isDestroyed()) {
        throw new Error("Desktop renderer is unavailable");
      }
      window.webContents.send(DESKTOP_EVENT_CHANNEL, envelope);
    },
    onError: (error) => console.error("Desktop event delivery error", safeDesktopErrorMessage(error)),
  });
  const dispatchRequest = createDesktopRequestDispatcher(handler, outbox, admission);
  const shutdownGate = createDesktopInvokeShutdownGate();
  let disposed = false;
  ipcMain.removeHandler(DESKTOP_INVOKE_CHANNEL);
  ipcMain.removeHandler(DESKTOP_EVENT_READY_CHANNEL);
  ipcMain.removeHandler(REMOTE_DESKTOP_CHANNEL);
  let pendingRemoteRequests = 0;
  ipcMain.handle(REMOTE_DESKTOP_CHANNEL, async (event, value: unknown) => {
    requireTrustedSender(event, window);
    const request = parseRemoteDesktopRequest(value);
    if (!remote || shutdownGate.isShuttingDown()) throw new Error("Desktop remote control is unavailable");
    // Keep the disable path available even while a setup/read is pending.
    if (request.type !== "disable" && pendingRemoteRequests >= 8) throw new Error("Too many remote management requests");
    pendingRemoteRequests += 1;
    try {
      return parseRemoteDesktopState(await remote.invoke(request));
    } catch (error) {
      throw new Error(safeDesktopErrorMessage(error));
    } finally {
      pendingRemoteRequests -= 1;
    }
  });
  ipcMain.handle(DESKTOP_INVOKE_CHANNEL, async (event, value: unknown) => {
    requireTrustedSender(event, window);
    return shutdownGate.invoke(() => dispatchRequest(value));
  });
  ipcMain.handle(DESKTOP_EVENT_READY_CHANNEL, (event) => {
    requireTrustedSender(event, window);
    if (shutdownGate.isShuttingDown()) return { version: 1, streamId: "stream_shutdown" };
    return outbox.rendererReady();
  });
  const acknowledge = (event: IpcMainEvent, value: unknown): void => {
    try {
      requireTrustedSender(event, window);
      outbox.acknowledge(parseDesktopEventAck(value));
    } catch (error) {
      console.error("Rejected desktop event ACK", safeDesktopErrorMessage(error));
    }
  };
  ipcMain.on(DESKTOP_EVENT_ACK_CHANNEL, acknowledge);

  return {
    publish: (event) => {
      if (!shutdownGate.isShuttingDown()) outbox.publish(event);
    },
    requestResync: (reason) => {
      if (!shutdownGate.isShuttingDown()) outbox.requestResync(reason);
    },
    beginShutdown: () => {
      if (shutdownGate.isShuttingDown()) return;
      shutdownGate.beginShutdown();
      ipcMain.removeListener(DESKTOP_EVENT_ACK_CHANNEL, acknowledge);
      outbox.dispose();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      shutdownGate.beginShutdown();
      ipcMain.removeHandler(DESKTOP_INVOKE_CHANNEL);
      ipcMain.removeHandler(DESKTOP_EVENT_READY_CHANNEL);
      ipcMain.removeHandler(REMOTE_DESKTOP_CHANNEL);
      ipcMain.removeListener(DESKTOP_EVENT_ACK_CHANNEL, acknowledge);
      outbox.dispose();
    },
  };
}

function requireTrustedSender(event: IpcMainInvokeEvent | IpcMainEvent, window: BrowserWindow): void {
  requireTrustedDesktopIpcSender({
    expectedWindow: window,
    ownerWindow: BrowserWindow.fromWebContents(event.sender),
    expectedWebContents: window.webContents,
    senderWebContents: event.sender,
    expectedMainFrame: window.webContents.mainFrame,
    senderFrame: event.senderFrame,
  }, {
    packaged: app.isPackaged,
    developmentRendererUrl: process.env.ELECTRON_RENDERER_URL,
  });
}
